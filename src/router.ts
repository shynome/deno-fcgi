/** 可执行脚本的扩展名，按匹配优先级排列 */
export const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".jsx", ".php"] as const;
export const INDEX_FILES = [
  "index.ts",
  "index.tsx",
  "index.mjs",
  "index.js",
  "index.jsx",
  "index.php",
];

export interface ScriptRoute {
  /** 脚本的真实绝对路径（已解析软链接） */
  scriptPath: string;
  /** 对外暴露的脚本名，例如 /api/hello.ts */
  scriptName: string;
  /** PATH_INFO，例如 /bar/baz */
  pathInfo: string;
  /** 命中的 root */
  documentRoot: string;
}

export class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RouteError";
  }
}

/**
 * 路由缓存的有效期。
 *
 * `resolve` 每次要做 2 次文件系统调用（探测候选 + realPath 解析软链接），
 * 短缓存能省掉大部分。取 2 秒是为了和常驻脚本的热更新周期对齐：
 * 新增脚本最迟 2 秒后可见。
 */
const RESOLVE_CACHE_TTL_MS = 2_000;
const RESOLVE_CACHE_MAX = 512;

interface CachedRoute {
  realPath: string;
  /** 给脚本用的 DOCUMENT_ROOT（Caddy 传来的原值） */
  documentRoot: string;
  expireAt: number;
}

export class Router {
  /** targetPath → 已校验的真实路径，只存成功结果（错误不缓存） */
  #cache = new Map<string, CachedRoute>();
  /** DOCUMENT_ROOT → realPath 解析结果，站点数很少，命中率极高 */
  #docRoots = new Map<string, string | null>();

  /**
   * 依据 FastCGI 参数解析出要执行的脚本。
   *
   * 优先使用 SCRIPT_FILENAME；缺失时回退 DOCUMENT_ROOT + SCRIPT_NAME。
   * 返回前会做软链接解析与 root 越界校验。
   */
  async resolve(params: Record<string, string>): Promise<ScriptRoute> {
    const scriptName = params["SCRIPT_NAME"] ?? "";
    const pathInfo = params["PATH_INFO"] ?? "";

    let filename = params["SCRIPT_FILENAME"] ?? "";
    if (!filename && params["DOCUMENT_ROOT"]) {
      filename = joinPath(params["DOCUMENT_ROOT"], scriptName);
    }
    if (!filename) {
      throw new RouteError(500, "missing SCRIPT_FILENAME");
    }

    // 兜底：某些客户端不会拆分 PATH_INFO，形如 /a/foo.ts/bar
    let targetPath = stripQuery(filename);
    if (!pathInfo) {
      const split = splitOnScriptExtension(targetPath);
      if (split) {
        targetPath = split.script;
      }
    }

    const cached = this.#cache.get(targetPath);
    if (cached && cached.expireAt > performance.now()) {
      return {
        scriptPath: cached.realPath,
        scriptName: scriptName ||
          toScriptName(cached.realPath, cached.documentRoot),
        pathInfo,
        documentRoot: cached.documentRoot,
      };
    }

    const candidate = await this.pickCandidate(targetPath);
    const realPath = await realPathOrNull(candidate);
    if (!realPath) {
      throw new RouteError(404, `script not found: ${candidate}`);
    }

    const documentRoot = params["DOCUMENT_ROOT"] ?? "";
    const boundary = await this.#matchDocumentRoot(realPath, documentRoot);
    if (!boundary) {
      throw new RouteError(403, `script outside document root: ${realPath}`);
    }

    // 给脚本的 DOCUMENT_ROOT 用 Caddy 传的原值（逻辑路径），
    // 它比 realPath 更适合脚本拼绝对路径
    this.#remember(targetPath, {
      realPath,
      documentRoot: documentRoot || boundary,
      expireAt: performance.now() + RESOLVE_CACHE_TTL_MS,
    });

    return {
      scriptPath: realPath,
      scriptName: scriptName || toScriptName(realPath, boundary),
      pathInfo,
      documentRoot: documentRoot || boundary,
    };
  }

  /** 用 Caddy 传的 DOCUMENT_ROOT 做边界校验 */
  async #matchDocumentRoot(
    realPath: string,
    documentRoot: string,
  ): Promise<string | null> {
    if (!documentRoot) return null;

    let realDocRoot = this.#docRoots.get(documentRoot);
    if (realDocRoot === undefined) {
      realDocRoot = await realPathOrNull(documentRoot);
      this.#docRoots.set(documentRoot, realDocRoot);
    }
    if (!realDocRoot) return null;
    if (realPath === realDocRoot) return realDocRoot;
    const prefix = realDocRoot.endsWith("/") ? realDocRoot : `${realDocRoot}/`;
    return realPath.startsWith(prefix) ? realDocRoot : null;
  }

  #remember(key: string, entry: CachedRoute): void {
    if (this.#cache.size >= RESOLVE_CACHE_MAX) {
      const now = performance.now();
      for (const [cachedKey, value] of this.#cache) {
        if (value.expireAt <= now) this.#cache.delete(cachedKey);
      }
      if (this.#cache.size >= RESOLVE_CACHE_MAX) {
        const oldest = this.#cache.keys().next();
        if (!oldest.done) this.#cache.delete(oldest.value);
      }
    }
    this.#cache.set(key, entry);
  }

  private async pickCandidate(targetPath: string): Promise<string> {
    const stat = await statOrNull(targetPath);
    if (stat?.isFile) {
      if (!hasScriptExtension(targetPath)) {
        throw new RouteError(403, `not a script file: ${targetPath}`);
      }
      return targetPath;
    }
    if (stat?.isDirectory) {
      for (const index of INDEX_FILES) {
        const candidate = joinPath(targetPath, index);
        const indexStat = await statOrNull(candidate);
        if (indexStat?.isFile) return candidate;
      }
      throw new RouteError(404, `no index file in ${targetPath}`);
    }
    // 文件不存在：再试 <path>.ts 这类省略扩展名的写法
    for (const ext of SCRIPT_EXTENSIONS) {
      const candidate = `${targetPath}${ext}`;
      const candidateStat = await statOrNull(candidate);
      if (candidateStat?.isFile) return candidate;
    }
    throw new RouteError(404, `script not found: ${targetPath}`);
  }
}

export function hasScriptExtension(path: string): boolean {
  return SCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** 在路径中第一个脚本扩展名之后切分，得到 script 与 pathInfo 的前半部分 */
export function splitOnScriptExtension(
  path: string,
): { script: string; rest: string } | null {
  let earliest = -1;
  let matched = "";
  for (const ext of SCRIPT_EXTENSIONS) {
    const index = path.indexOf(`${ext}/`);
    if (index >= 0 && (earliest < 0 || index < earliest)) {
      earliest = index;
      matched = ext;
    }
  }
  if (earliest < 0) return null;
  return {
    script: path.slice(0, earliest + matched.length),
    rest: path.slice(earliest + matched.length),
  };
}

export function joinPath(base: string, child: string): string {
  if (!child) return normalizePath(base);
  if (child.startsWith("/") && base.endsWith("/")) return normalizePath(base + child.slice(1));
  if (child.startsWith("/")) return normalizePath(base + child);
  return normalizePath(`${base}/${child}`);
}

/** 折叠 . 与 ..，不访问文件系统 */
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `${isAbsolute ? "/" : ""}${parts.join("/")}`;
}

function stripQuery(path: string): string {
  const index = path.indexOf("?");
  return index >= 0 ? path.slice(0, index) : path;
}

function toScriptName(realPath: string, root: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return realPath.startsWith(prefix) ? `/${realPath.slice(prefix.length)}` : realPath;
}

async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return null;
    }
    throw error;
  }
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.realPath(path);
  } catch {
    return null;
  }
}
