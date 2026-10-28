/**
 * Worker 执行池，支持两种脚本形态：
 *
 * - `export default { fetch }`（resident）
 *   首次请求加载后不销毁；同一脚本可保留多个 Worker，
 *   单 Worker 内串行（注入的 CGI 上下文是全局对象），跨 Worker 并行。
 *
 * - 顶层执行式（ephemeral）
 *   顶层代码必须每请求重新执行，所以用完立即 terminate；
 *   按「权限 key」预热空壳，让热点脚本命中已初始化的 isolate。
 */
import type { ScriptJob, ScriptResult } from "../types.ts";

export interface PoolOptions {
  workerUrl: URL;
  /** 同时运行的 Worker 上限 */
  maxWorkers: number;
  /** 每个 ephemeral 脚本保留的空壳数量 */
  prewarm: number;
  /** 单请求超时 */
  requestTimeoutMs: number;
  /** 默认权限（不含脚本文件本身，运行时会自动追加） */
  defaultPermissions: Deno.PermissionOptions;
  /** 单个脚本最多保留的常驻 Worker 数（默认 4，受 maxWorkers 约束） */
  residentConcurrency?: number;
  /**
   * 常驻 Worker 空闲多久后回收（默认 30s，负数=不回收）。
   * 多余的空闲槽按这个值回收，最后一个按 5 倍时间。
   */
  residentIdleMs?: number;
  /** 常驻 Worker 被丢弃时回调 */
  onEvict?: (scriptPath: string, reason: EvictReason) => void;
}

export type EvictReason = "stale" | "error" | "idle";

/** 首次加载的结果：`result` 只属于发起加载的那个请求 */
interface BootstrapResult {
  pool: ResidentPool | null;
  result: ScriptResult;
}

export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`script execution timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

const READY_TIMEOUT_MS = 10_000;

/**
 * 常驻脚本的重新校验间隔。
 *
 * 对齐 PHP opcache 的默认行为：`opcache.validate_timestamps=1`、
 * `opcache.revalidate_freq=2`，即每 2 秒检查一次文件时间戳。
 * 检查在后台跑，请求路径上不做任何 stat。
 */
const REVALIDATE_INTERVAL_MS = 2_000;

/** 最后一个空闲 Worker 的回收阈值 = residentIdleMs × 该倍数 */
const LAST_SLOT_IDLE_FACTOR = 5;

interface ResidentSlot {
  worker: Worker;
  /** 正在处理的请求数。只有 0 才可复用：上下文注入改的是全局对象 */
  pending: number;
  /** 最近一次空闲下来的时间，用于空闲回收 */
  lastUsedAt: number;
}

/** 预热池里的空壳，带时间戳以便 TTL 回收 */
interface IdleWorker {
  worker: Worker;
  since: number;
}

interface ResidentPool {
  /** 所属权限配置 key */
  workerKey: string;
  /** 常驻槽的完整 key（权限 + 脚本路径） */
  residentKey: string;
  scriptPath: string;
  slots: ResidentSlot[];
  /** 该脚本的并发许可，容量 = residentConcurrency */
  sem: Semaphore;
  /** 加载时的 mtime（毫秒），0 表示无法获取 */
  mtimeMs: number;
  /** 加载时的文件大小，与 mtime 组成变更指纹 */
  size: number;
  /** 空闲回收定时器 */
  trimTimer?: ReturnType<typeof setTimeout>;
  /** 定时器对应的绝对到期时间（performance.now 基准） */
  trimDeadline?: number;
  /** 已被丢弃，唤醒中的等待者需要重试 */
  disposed: boolean;
}

/** 常驻池在校验中被丢弃，等待中的请求需要重新走一轮 */
class PoolDisposedError extends Error {
  constructor() {
    super("resident pool disposed");
    this.name = "PoolDisposedError";
  }
}

/** 简单信号量，用于限制单个脚本的并发 Worker 数 */
class Semaphore {
  #available: number;
  #waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.#available = permits;
  }

  async acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available--;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#available++;
  }

  /** 关闭时唤醒所有等待者，让它们走异常路径 */
  drain(): void {
    while (this.#waiters.length > 0) this.#waiters.shift()!();
  }
}

export class WorkerPool {
  #idle = new Map<string, IdleWorker[]>();
  #resident = new Map<string, ResidentPool>();
  /** 正在加载中的脚本，避免并发首请求各自建一个常驻池 */
  #createLocks = new Map<string, Promise<BootstrapResult>>();
  #active = 0;
  #waiters: Array<() => void> = [];
  #closed = false;
  #concurrency: number;
  /** 在途执行的 reject 回调，close() 时全部触发，避免卡到超时 */
  #aborts = new Set<(error: Error) => void>();
  /** 后台文件指纹校验定时器，仅在存在常驻池时运行 */
  #revalidator?: ReturnType<typeof setInterval>;
  /** 空闲空壳的 TTL 清扫定时器 */
  #idleTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: PoolOptions) {
    this.#concurrency = Math.max(
      1,
      Math.min(options.residentConcurrency ?? 4, options.maxWorkers),
    );
  }

  get stats(): {
    idle: number;
    residentWorkers: number;
    residentScripts: number;
    active: number;
    queued: number;
  } {
    let idle = 0;
    for (const list of this.#idle.values()) idle += list.length;
    let residentWorkers = 0;
    for (const pool of this.#resident.values()) {
      residentWorkers += pool.slots.length;
    }
    return {
      idle,
      residentWorkers,
      residentScripts: this.#resident.size,
      active: this.#active,
      queued: this.#waiters.length,
    };
  }

  async run(
    job: ScriptJob,
    permissions?: Deno.PermissionOptions,
  ): Promise<ScriptResult> {
    const effective = resolvePermissions(
      permissions ?? this.options.defaultPermissions,
      job.scriptPath,
    );
    // 空壳 Worker 与脚本无关，预热池只按权限配置区分
    const workerKey = JSON.stringify(effective);
    // 常驻槽必须额外带上脚本路径：read=* 时权限里不含路径，
    // 仅靠 workerKey 会让不同脚本共用一个 Worker
    const residentKey = `${workerKey}|${job.scriptPath}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      const pool = this.#resident.get(residentKey);
      if (pool) {
        try {
          return await this.#runResident(pool, workerKey, residentKey, job, effective);
        } catch (error) {
          // 等待期间池被后台校验丢弃，重新走一轮
          if (error instanceof PoolDisposedError) continue;
          throw error;
        }
      }

      // 已有请求在加载这个脚本：等它出结果，避免重复建池
      const inflight = this.#createLocks.get(residentKey);
      if (inflight) {
        const shared = await inflight;
        if (shared.pool) {
          return await this.#runResident(
            shared.pool,
            workerKey,
            residentKey,
            job,
            effective,
          );
        }
        // 脚本是 ephemeral，没有池可复用，自己执行一次
        continue;
      }

      const booting = this.#bootstrap(workerKey, residentKey, job, effective);
      this.#createLocks.set(residentKey, booting);
      try {
        const created = await booting;
        return created.result;
      } finally {
        this.#createLocks.delete(residentKey);
      }
    }

    throw new Error(`failed to resolve script: ${job.scriptPath}`);
  }

  close(): void {
    this.#closed = true;
    this.#stopRevalidator();
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }

    // 先中断在途执行：被 terminate 的 Worker 不会再回消息，
    // 否则 #execute 的 promise 要一直挂到 requestTimeoutMs（默认 30s）
    for (const abort of [...this.#aborts]) {
      abort(new Error("worker pool is closed"));
    }
    this.#aborts.clear();

    for (const list of this.#idle.values()) {
      for (const entry of list) entry.worker.terminate();
    }
    this.#idle.clear();
    for (const pool of this.#resident.values()) {
      if (pool.trimTimer !== undefined) clearTimeout(pool.trimTimer);
      for (const slot of pool.slots) slot.worker.terminate();
      pool.sem.drain();
    }
    this.#resident.clear();
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.();
    }
  }

  /**
   * 首次加载脚本：跑一次请求，顺便判定它是 ephemeral 还是 resident。
   * resident 的 Worker 会被收进常驻池，不 terminate。
   */
  async #bootstrap(
    workerKey: string,
    residentKey: string,
    job: ScriptJob,
    effective: Deno.PermissionOptions,
  ): Promise<BootstrapResult> {
    await this.#acquire();
    let worker: Worker | undefined;
    let keep = false;
    try {
      worker = this.#takeIdle(workerKey) ??
        await createReadyWorker(this.options.workerUrl, effective);
      const result = await this.#execute(worker, job);

      if (result.mode === "resident") {
        keep = true;
        const pool = await this.#createResidentPool(
          worker,
          workerKey,
          residentKey,
          job.scriptPath,
        );
        this.#resident.set(residentKey, pool);
        this.#ensureRevalidator();
        // 首个请求已经跑完，槽已空闲，从这一刻开始算空闲时间
        this.#scheduleTrim(pool);
        return { pool, result };
      }
      return { pool: null, result };
    } finally {
      if (!keep) {
        worker?.terminate();
        this.#prewarm(workerKey, effective);
      }
      this.#release();
    }
  }

  /**
   * 常驻脚本的请求入口。
   *
   * 调度顺序：先拿全局 Worker 许可，再拿该脚本的并发许可，
   * 然后挑一个空闲 Worker；没有空闲且许可还有余就扩容。
   */
  async #runResident(
    pool: ResidentPool,
    workerKey: string,
    residentKey: string,
    job: ScriptJob,
    effective: Deno.PermissionOptions,
  ): Promise<ScriptResult> {
    await this.#acquire();
    await pool.sem.acquire();
    try {
      if (this.#closed) throw new Error("worker pool is closed");
      // 排队期间池可能已被后台校验丢弃
      if (pool.disposed) throw new PoolDisposedError();

      const slot = pool.slots.find((item) => item.pending === 0);
      if (slot) {
        slot.pending++;
        try {
          return await this.#execute(slot.worker, job);
        } catch (error) {
          this.#removeSlot(pool, slot, "error");
          throw error;
        } finally {
          slot.pending--;
          slot.lastUsedAt = performance.now();
        }
      }

      // 许可有余但暂无空闲 Worker → 扩容一个
      const worker = await createReadyWorker(this.options.workerUrl, effective);
      const fresh: ResidentSlot = {
        worker,
        pending: 1,
        lastUsedAt: performance.now(),
      };
      pool.slots.push(fresh);
      try {
        const result = await this.#execute(worker, job);
        // 理论上仍是 resident；若脚本形态变了则不留
        if (result.mode !== "resident") {
          this.#removeSlot(pool, fresh, "error");
        }
        return result;
      } catch (error) {
        this.#removeSlot(pool, fresh, "error");
        throw error;
      } finally {
        fresh.pending--;
        fresh.lastUsedAt = performance.now();
      }
    } finally {
      pool.sem.release();
      this.#release();
      this.#scheduleTrim(pool);
    }
  }

  /** 创建常驻池，记录脚本当前的 mtime/size 作为变更指纹 */
  async #createResidentPool(
    worker: Worker,
    workerKey: string,
    residentKey: string,
    scriptPath: string,
  ): Promise<ResidentPool> {
    const stat = await statOrNull(scriptPath);
    return {
      workerKey,
      residentKey,
      scriptPath,
      slots: [{ worker, pending: 0, lastUsedAt: performance.now() }],
      sem: new Semaphore(this.#concurrency),
      mtimeMs: stat?.mtime?.getTime() ?? 0,
      size: stat?.size ?? 0,
      disposed: false,
    };
  }

  /** 有常驻池时才启动后台校验定时器，空载不耗资源 */
  #ensureRevalidator(): void {
    if (this.#closed || this.#revalidator !== undefined) return;
    this.#revalidator = setInterval(() => {
      this.#revalidate();
    }, REVALIDATE_INTERVAL_MS);
  }

  #stopRevalidator(): void {
    if (this.#revalidator === undefined) return;
    clearInterval(this.#revalidator);
    this.#revalidator = undefined;
  }

  /**
   * 后台异步校验所有常驻脚本的文件指纹。
   * 不阻塞任何请求，也没人会 await 它。
   */
  #revalidate(): void {
    if (this.#closed) return;
    if (this.#resident.size === 0) {
      this.#stopRevalidator();
      return;
    }
    for (const pool of [...this.#resident.values()]) {
      // 有请求在跑就不动，等下个周期
      if (pool.slots.some((slot) => slot.pending > 0)) continue;
      this.#revalidatePool(pool).catch(() => {
        // stat 失败不致命，下个周期再试
      });
    }
  }

  async #revalidatePool(pool: ResidentPool): Promise<void> {
    const stat = await statOrNull(pool.scriptPath);
    // 文件被删也让位，下次请求会重新路由/报错
    if (!stat) {
      this.#removePool(pool, "stale");
      return;
    }
    const mtimeMs = stat.mtime?.getTime() ?? 0;
    if (mtimeMs !== pool.mtimeMs || stat.size !== pool.size) {
      this.#removePool(pool, "stale");
    }
  }

  #removeSlot(pool: ResidentPool, slot: ResidentSlot, reason: EvictReason): void {
    const index = pool.slots.indexOf(slot);
    if (index >= 0) pool.slots.splice(index, 1);
    slot.worker.terminate();
    this.options.onEvict?.(pool.scriptPath, reason);
    if (pool.slots.length === 0) this.#disposePool(pool);
  }

  #removePool(pool: ResidentPool, reason: EvictReason): void {
    this.options.onEvict?.(pool.scriptPath, reason);
    for (const slot of pool.slots) slot.worker.terminate();
    pool.slots.length = 0;
    this.#disposePool(pool);
  }

  /** 从索引里摘掉整个池，并唤醒还在排队的请求让它们重试 */
  #disposePool(pool: ResidentPool): void {
    if (pool.disposed) return;
    pool.disposed = true;
    if (pool.trimTimer !== undefined) {
      clearTimeout(pool.trimTimer);
      pool.trimTimer = undefined;
      pool.trimDeadline = undefined;
    }
    this.#resident.delete(pool.residentKey);
    pool.sem.drain();
    if (this.#resident.size === 0) this.#stopRevalidator();
  }

  /**
   * 回收空闲超时的 Worker。
   *
   * 最近用过的那个槽是「最后一个」，用 `residentIdleMs` 的 5 倍时间，
   * 避免热脚本刚冷下来就被回收；它被回收后整个池会一起摘掉。
   */
  #trimPool(pool: ResidentPool): void {
    const idleMs = this.options.residentIdleMs ?? 30_000;
    if (this.#closed || pool.disposed || idleMs < 0) return;

    const now = performance.now();
    const idle = pool.slots.filter((slot) => slot.pending === 0);
    if (idle.length === 0) return;

    idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const keeper = idle[idle.length - 1];

    for (const slot of idle.slice(0, idle.length - 1)) {
      if (now - slot.lastUsedAt >= idleMs) this.#removeSlot(pool, slot, "idle");
    }
    if (now - keeper.lastUsedAt >= idleMs * LAST_SLOT_IDLE_FACTOR) {
      this.#removeSlot(pool, keeper, "idle");
    }
    this.#scheduleTrim(pool);
  }

  /** 按「最早到期的空闲槽」调度下一次检查，不轮询 */
  #scheduleTrim(pool: ResidentPool): void {
    if (this.#closed || pool.disposed) return;
    const idleMs = this.options.residentIdleMs ?? 30_000;
    if (idleMs < 0) return;

    const now = performance.now();
    const idle = pool.slots.filter((slot) => slot.pending === 0);
    // 没有空闲槽（都在跑），下一轮由请求结束时的调用负责
    if (idle.length === 0) return;

    idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const keeper = idle[idle.length - 1];
    let wait = idleMs * LAST_SLOT_IDLE_FACTOR - (now - keeper.lastUsedAt);
    for (const slot of idle.slice(0, idle.length - 1)) {
      const remaining = idleMs - (now - slot.lastUsedAt);
      if (remaining < wait) wait = remaining;
    }

    const deadline = now + Math.max(0, wait);
    // 已经有更早的定时器就别动；有更晚的到期就重新排，
    // 否则扩容出来的槽会被旧定时器拖到很久之后才回收
    if (pool.trimTimer !== undefined) {
      if (pool.trimDeadline !== undefined && pool.trimDeadline <= deadline) return;
      clearTimeout(pool.trimTimer);
      pool.trimTimer = undefined;
    }

    pool.trimDeadline = deadline;
    pool.trimTimer = setTimeout(() => {
      pool.trimTimer = undefined;
      pool.trimDeadline = undefined;
      this.#trimPool(pool);
    }, Math.max(0, wait));
  }

  /** 已有同权限配置的常驻 Worker 时不再预热空壳 */
  #hasResident(workerKey: string): boolean {
    for (const pool of this.#resident.values()) {
      if (pool.workerKey === workerKey) return true;
    }
    return false;
  }

  #takeIdle(key: string): Worker | undefined {
    const entry = this.#idle.get(key)?.pop();
    if (!entry) return undefined;
    const ttl = this.options.residentIdleMs ?? 30_000;
    // 过期的空壳不对外用，直接丢掉让调用方新建
    if (ttl >= 0 && performance.now() - entry.since >= ttl) {
      entry.worker.terminate();
      return undefined;
    }
    return entry.worker;
  }

  /** 空闲空壳的 TTL 清扫：没有新请求进来时也要能把它们放掉 */
  #scheduleIdleSweep(): void {
    if (this.#closed || this.#idleTimer !== undefined) return;
    const ttl = this.options.residentIdleMs ?? 30_000;
    if (ttl < 0 || this.#idleTotal() === 0) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      this.#sweepIdle();
    }, ttl);
  }

  #sweepIdle(): void {
    const ttl = this.options.residentIdleMs ?? 30_000;
    if (ttl < 0) return;
    const now = performance.now();
    for (const [key, list] of this.#idle) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (now - list[i].since < ttl) continue;
        list[i].worker.terminate();
        list.splice(i, 1);
      }
      if (list.length === 0) this.#idle.delete(key);
    }
    this.#scheduleIdleSweep();
  }

  /** 所有权限分组里空闲空壳的总数（预热池是跨脚本共享的，必须整体设上限） */
  #idleTotal(): number {
    let total = 0;
    for (const list of this.#idle.values()) total += list.length;
    return total;
  }

  /** ephemeral 脚本请求结束后异步补一个空壳，不阻塞当前请求 */
  #prewarm(key: string, permissions: Deno.PermissionOptions): void {
    if (this.#closed || this.options.prewarm <= 0) return;
    if (this.#hasResident(key)) return;

    const list = this.#idle.get(key) ?? [];
    this.#idle.set(key, list);
    if (list.length >= this.options.prewarm) return;
    // 按「全部空闲空壳 + 在跑」算，否则每种权限配置各自攒一个会撑爆内存
    if (this.#idleTotal() + this.#active >= this.options.maxWorkers) return;

    createReadyWorker(this.options.workerUrl, permissions).then((worker) => {
      if (this.#closed || this.#hasResident(key)) {
        worker.terminate();
        return;
      }
      list.push({ worker, since: performance.now() });
      this.#scheduleIdleSweep();
    }).catch(() => {
      // 预热失败不影响请求，下次会重新创建
    });
  }

  /** 创建一个 Worker 并执行一次请求（含超时） */
  #execute(worker: Worker, job: ScriptJob): Promise<ScriptResult> {
    return new Promise<ScriptResult>((resolve, reject) => {
      let settled = false;

      /** 统一收尾：解除 abort 注册、清定时器 */
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        this.#aborts.delete(abort);
        clearTimeout(timer);
        action();
      };
      const abort = (error: Error) => settle(() => reject(error));

      const timer = setTimeout(() => {
        if (settled) return;
        worker.terminate();
        settle(() => reject(new RequestTimeoutError(this.options.requestTimeoutMs)));
      }, this.options.requestTimeoutMs);

      this.#aborts.add(abort);

      worker.onmessage = (event: MessageEvent<ScriptResult>) => {
        settle(() => resolve(event.data));
      };
      worker.onerror = (event: ErrorEvent | Event) => {
        const message = event instanceof ErrorEvent ? event.message : "worker crashed";
        settle(() => reject(new Error(message)));
      };
      worker.onmessageerror = () => {
        settle(() => reject(new Error("worker message could not be deserialized")));
      };

      worker.postMessage(job);
    });
  }

  async #acquire(): Promise<void> {
    if (this.#closed) throw new Error("worker pool is closed");
    if (this.#active < this.options.maxWorkers) {
      this.#active++;
      return;
    }
    // 槽位由 #release 直接移交，这里不再自增
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#active = Math.max(0, this.#active - 1);
  }
}

/** 创建一个 Worker 并等待它回发 ready */
function createReadyWorker(
  workerUrl: URL,
  permissions: Deno.PermissionOptions,
): Promise<Worker> {
  const options: WorkerOptions & {
    deno?: { permissions: Deno.PermissionOptions };
  } = {
    type: "module",
    deno: { permissions },
  };
  const worker = new Worker(workerUrl, options as WorkerOptions);

  return new Promise<Worker>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("worker init timeout"));
    }, READY_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type !== "ready") return;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      resolve(worker);
    };
    worker.onerror = (event: ErrorEvent | Event) => {
      clearTimeout(timer);
      const message = event instanceof ErrorEvent ? event.message : "worker failed to start";
      worker.terminate();
      reject(new Error(message));
    };
  });
}

/**
 * 保证脚本文件本身可读，其余权限原样保留。
 * 配置了 FCGI_ALLOW_READ 时，用户不需要再把脚本目录写进去。
 */
function resolvePermissions(
  permissions: Deno.PermissionOptions,
  scriptPath: string,
): Deno.PermissionOptions {
  if (typeof permissions === "string") {
    throw new Error(
      `unsupported permissions value: ${permissions}（不支持继承主进程权限）`,
    );
  }
  if (permissions.read === true) return permissions;

  const read = Array.isArray(permissions.read) ? permissions.read : [];
  return {
    ...permissions,
    read: [...new Set([...read, scriptPath])],
  };
}

/** stat 失败（文件被删/无权限）时返回 null，不影响请求流程 */
async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch {
    return null;
  }
}
