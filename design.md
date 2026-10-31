# deno-fcgi 设计文档

面向 Deno 脚本的 FastCGI 服务端，放在 Caddy 后面，行为尽量贴近 PHP-FPM： **URL
路径直接映射到磁盘上的脚本文件**，无需把每个脚本单独注册成服务。

---

## 1. 目标与非目标

### 目标

- 实现标准 FastCGI responder，Caddy 通过 `transport fastcgi` 接入
- 多脚本：`/api/hello.php`、`/admin/index.php` 各自独立运行，无需重启服务
- CGI 风格脚本：脚本内直接读 `process.env` / `Deno.stdin`，用 `console.log` 输出响应
- 脚本级权限隔离：每个脚本只能访问配置允许的路径 / 域名
- 单进程常驻，脚本跑在 Worker 里；`deno compile` 出单文件二进制

### 非目标（第一版）

- 不做 asgi / wsgi 兼容层
- 不做集群 / 多机负载均衡（Caddy 侧可用 upstream 池）
- 不实现 FastCGI 的 `FILTER` 角色，只做 `RESPONDER`
- 不自动安装依赖，脚本依赖由用户自己的 `deno.json` / import map 决定

---

## 2. 整体架构

```
                    ┌──────────────────────────────────────────┐
Browser ──HTTP──> Caddy ──FastCGI(unix socket)──> deno-fcgi │
                    └──────────────────────────────────────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │  main (Deno, 单进程)             │
                  │  ├─ fcgi/protocol   帧编解码      │
                  │  ├─ fcgi/server     连接状态机    │
                  │  ├─ router          路径 → 脚本   │
                  │  └─ pool            并发控制      │
                  └────────────────┬────────────────┘
                                   │  每请求一个 Worker
                                   │ （常驻形态下复用同一个）
                  ┌────────────────┴────────────────┐
                  │  Worker isolate                  │
                  │  ├─ 注入 CGI 上下文               │
                  │  ├─ import(file:// 脚本)          │
                  │  └─ 顶层执行 或 调 default.fetch  │
                  └─────────────────────────────────┘
```

### 为什么不用 `Deno.serve`

FastCGI 是二进制协议（8 字节定长帧头），`Deno.serve` 只处理 HTTP。 主进程用
`Deno.listen({ transport: "unix", path })` 收裸 TCP 流，自己解析帧。

### 为什么用 Worker 而不是子进程

- 冷启动：Worker ≈ 5–20ms，子进程 ≈ 40–100ms
- 内存：Worker 共享主进程堆外资源，子进程每个独立 V8 实例
- 权限：Worker 支持 `deno.permissions` 降级（需 `--unstable-worker-options`）

代价是 `Deno.env` 是进程级共享的，因此需要下面的「隔离补丁」。

---

## 3. FastCGI 协议层

### 帧格式

```
version:1 type:1 requestId:2 contentLength:2 paddingLength:1 reserved:1
```

需要实现的 type：

| type              | 方向         | 说明                                      |
| ----------------- | ------------ | ----------------------------------------- |
| BEGIN_REQUEST (1) | Caddy → 我们 | role + flags(keep_conn)                   |
| ABORT_REQUEST (2) | Caddy → 我们 | 中断请求（客户端断开）                    |
| PARAMS (4)        | Caddy → 我们 | 逐帧到达，以空帧结束                      |
| STDIN (5)         | Caddy → 我们 | 请求体，以空帧结束                        |
| STDOUT (6)        | 我们 → Caddy | 响应数据                                  |
| STDERR (7)        | 我们 → Caddy | 脚本错误输出，Caddy `capture_stderr` 记录 |
| END_REQUEST (3)   | 我们 → Caddy | appStatus + protocolStatus                |
| GET_VALUES (9)    | Caddy → 我们 | 可选，返回少量能力声明                    |

### 连接模型

- 一条连接上可多路复用多个 `requestId`（`keep_conn` 时必须支持）
- 每个连接维护 `Map<requestId, RequestState>`，独立状态机：
  `WAIT_PARAMS → WAIT_STDIN → RUNNING → DONE`
- 并发上限：单连接同时最多 64 个请求（`maxRequestsPerConnection`，暂未暴露成 CLI 参数），超出时按
  `OVERLOADED` 结束请求
- 背压：STDOUT 写入走 `Deno.Writer.write` 并 `await`，不无限缓冲

### 关键常量

```
FCGI_VERSION = 1
FCGI_RESPONDER = 1
FCGI_REQUEST_COMPLETE = 0
FCGI_CANT_MPX_CONN = 1
FCGI_OVERLOADED = 2
FCGI_UNKNOWN_ROLE = 3
FCGI_MAX_LENGTH = 65535
```

### 响应写出

1. 脚本输出前若干字节，解析出 CGI 头，直到 `\r\n\r\n`
2. 头转成 CGI 响应：`Status: 404 Not Found` 直接作为状态；缺省 200
3. 之后的数据边收边包成 STDOUT 帧（每帧 ≤ 65535 字节，惯例 32KB）
4. 全部结束时发空 STDOUT 帧 + END_REQUEST

> 注意：Caddy 侧 FastCGI **不支持 chunked 请求体**，无 `Content-Length` 的请求会被 411。 这是 Caddy
> 的限制，不是本项目的，需在 README 说明。

---

## 4. 路由规则

以 Caddy 通过 PARAMS 传来的变量为准：

```
SCRIPT_FILENAME   /srv/site/api/hello.php    ← 主依据
SCRIPT_NAME       /api/hello.php
PATH_INFO         /bar/baz                   ← 可能为空
DOCUMENT_ROOT     /srv/site
```

解析流程：

1. `SCRIPT_FILENAME` 为空时回退 `DOCUMENT_ROOT + SCRIPT_NAME`
2. `realPath(SCRIPT_FILENAME)`，解析软链接后校验它位于 `realPath(DOCUMENT_ROOT)` 之内 （防 `..`
   与符号链接逃逸）
3. 判定：
   - 是文件且扩展名就是 `.php` → 执行（内容是 **JavaScript**，Deno 对未知扩展名按 JS 解析）
   - 是目录 → 尝试 `<dir>/index.php`
   - 其它扩展名一律 403，不存在的路径直接 404
   - 都不满足 → 404（可选：回退 `DOCUMENT_ROOT/index.php`，由 Caddy `try_files` 控制）
4. `PATH_INFO` 原样放进环境变量，交给脚本自行路由（Hono 可吃）

### 路由缓存

`resolve` 每次要 2 次文件系统调用（探测候选 + `realPath` 解析软链接），所以结果按 `targetPath` 缓存
2 秒，上限 512 条（只存成功结果，错误不缓存）。

TTL 取 2 秒是为了和常驻脚本的热更新周期一致：新增脚本立即可见（首次不命中缓存）， **删除/改名后最长
2 秒内仍会路由到旧路径**。

### DOCUMENT_ROOT 既是路径也是边界

`DOCUMENT_ROOT` 由 Caddy 从它自己的 `root` 指令生成，同时承担两个作用：

1. 校验脚本没有跑到 webroot 之外
2. 作为环境变量交给脚本拼绝对路径（如 `DOCUMENT_ROOT + "/data.txt"`）

两个用途用的是**同一个值**，不做任何改写。早期实现曾把安全边界的结果写回
`DOCUMENT_ROOT`，一旦边界配得比 webroot 深，脚本拼出来的路径就全错了，已修正。

边界校验会先把 `DOCUMENT_ROOT` 也 `realPath` 一次（带小缓存），因为 webroot 本身可能是软链接。 未传
`DOCUMENT_ROOT` 时直接 403 —— 没有基准就无从判断，不默认信任 `SCRIPT_FILENAME`。

---

## 5. 脚本运行时（CGI 语义注入）

脚本就是一个普通 Deno 脚本，不 import 任何宿主 SDK 也能跑：

```js
// public/api/hello.php
const method = process.env.REQUEST_METHOD;
const name = new URL("http://x" + process.env.REQUEST_URI).searchParams.get("name");

console.log("Content-Type: text/plain; charset=utf-8");
console.log("");
console.log(`hello ${name ?? "world"}, method=${method}`);
```

Worker 的 bootstrap 在 import 脚本前做这些事：

| 注入对象              | 做法                                                                              | 实测                                         |
| --------------------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| `process.env`         | 复用同一个普通对象，每请求清空再填充                                              | ✅ 不影响主线程                              |
| `Deno.stdin`          | `defineProperty` 替换为内存 body 的 reader                                        | ✅                                           |
| `Deno.stdout`         | 替换为把字节追加到响应缓冲的 writer                                               | ✅                                           |
| `Deno.stderr`         | 替换为发 FCGI_STDERR 的 writer                                                    | ✅                                           |
| `console`             | 整体替换，`log/info/debug → stdout`，`warn/error → stderr`                        | ✅ console 不走 `Deno.stdout`，必须单独 hook |
| `Deno.env`            | 替换 `globalThis.Deno` 为浅代理，`env.get/set/toObject` 转发到当前请求的 env 对象 | ✅                                           |
| 全局 `Buffer`         | 从 `node:buffer` 注入，供 Node 生态库使用                                         | ✅                                           |
| `process.stdout.push` | 作为 `write` 的别名（兼容 0.1.x 的 hono-cgi-adapter）                               | ✅                                           |

常驻 Worker 下这套注入是**每请求**都要做的，所以 Proxy、console、各个流对象都在模块级
只创建一次，每请求只换内部指向的 `RequestState`（env 清空再填充、offset/out/err 重置、
新建可读流）。可读流直接闭包捕获本次的 `RequestState`，避免延迟读取时串到新请求。 把
`defineProperty` 和对象构造从热路径上拿掉后，这部分开销已可以忽略不计。

### 第三方适配器兼容

已验证 [hono-cgi-adapter](https://github.com/taisan11/hono-cgi-adapter)：

```ts
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();
app.get("/", (c) => c.text("Hello"));
await handlecgi(app, process.env);
```

它依赖 `process.stdin` 的 async iterator、`process.stdout.write`（0.1.x 还会把 `push`
当 `write` 用）、全局 `Buffer`、`process.env`，这些均由 bootstrap 提供。

0.2.0 起它会自己把 `QUERY_STRING` 拼进 URL，并把 `HTTP_*` 规范化为 `x-forwarded-for`
这类头名，`c.req.query()` / `c.req.header()` 可直接使用；0.1.x 需要自己解析。

注意该适配器只把 `PATH_INFO` 当作请求路径，不含 `SCRIPT_NAME`：

| 浏览器访问              | Hono 看到的路径 |
| ----------------------- | --------------- |
| `/api/hono.php`         | `/`             |
| `/api/hono.php/users/1` | `/users/1`      |

`examples/` 下所有示例均采用这种写法。

npm/jsr 模块的下载与缓存读取是 Deno 加载器行为，不受脚本权限约束， 降权目录里也能正常加载；需要
`read` 权限的只有本地相对路径模块。

### 环境变量清单

标准 CGI 变量全部注入：`GATEWAY_INTERFACE`、`SERVER_SOFTWARE`、`SERVER_PROTOCOL`、
`REQUEST_METHOD`、`REQUEST_URI`、`QUERY_STRING`、`CONTENT_TYPE`、`CONTENT_LENGTH`、
`SCRIPT_FILENAME`、`SCRIPT_NAME`、`PATH_INFO`、`PATH_TRANSLATED`、`DOCUMENT_ROOT`、
`REMOTE_ADDR`、`REMOTE_PORT`、`SERVER_ADDR`、`SERVER_PORT`、`SERVER_NAME`、`HTTPS`、 以及 `HTTP_*`
形式的请求头。

宿主进程自身的环境变量**不继承**：脚本只能看到本次请求的 CGI 变量， `process.env` / `Deno.env`
都指向这份数据。

### 并发与全局状态

`process.env` / `console` 的 hook 是 isolate 级全局，所以两种形态的隔离方式不同：

- **顶层执行式**：每请求一个全新 Worker，天然无跨请求串扰，不需要串行化
- **常驻（`default.fetch`）**：同一个 Worker 内请求**串行**（并发靠多个 Worker 叠加， 见
  §6），模块状态在请求间共享

两种形态的总并发都受 `maxWorkers` 限制，超出的请求排队。

### 执行模型（重要）

支持两种脚本形态，由 wrapper 自动识别：

| 形态                                      | 判定                   | Worker 生命周期 | 热门请求耗时 |
| ----------------------------------------- | ---------------------- | --------------- | ------------ |
| `export default { fetch }`（含 Hono app） | `default.fetch` 是函数 | 常驻复用        | **1–2 ms**   |
| 顶层执行式（PHP 风格）                    | 无 default 导出        | 每请求新建      | ~30 ms       |

顶层执行式必须是新 isolate（模块只能求值一次）；`fetch` 形态则只需加载一次， 每请求构造标准
`Request` 调用 `fetch`，输出由 wrapper 转成 CGI 字节流。

`Request` 的 URL 与 CGI 语义保持一致：path 取 `PATH_INFO`（`SCRIPT_NAME` 已被 Caddy 的
`split` 剥掉），query 取 `QUERY_STRING`。所以两种形态下框架看到的路径相同——
`/api/hello.php/users/42` 都是 `/users/42`——路由不需要写 `basePath`。 需要原始完整地址（含脚本名）时读
`process.env.REQUEST_URI`，它照旧注入。

两种形态下 `import.meta.url` 都是正常的 `file://` URL。

```js
// public/api/hello.php —— 顶层就是逻辑
const method = process.env.REQUEST_METHOD;
const name = new URL("http://x" + process.env.REQUEST_URI).searchParams.get("name");

console.log("Content-Type: text/plain; charset=utf-8");
console.log("");
console.log(`hello ${name ?? "world"}, method=${method}`);
```

- 每次请求都重新 `import(scriptUrl)`，顶层代码重新求值
- Worker 的 read 默认是整个 `DOCUMENT_ROOT`，所以相对导入和读站点内文件都能用； 站点之外仍然
  `NotCapable`
- DB 连接等资源每请求新建、随 Worker 销毁释放（与 PHP 一致）
- 需要跨请求共享状态时，用外部服务（redis / 数据库），不在进程内缓存

---

## 6. Worker 生命周期

```ts
interface PoolOptions {
  maxWorkers: number; // 同时存活的 Worker 上限，默认 16
  prewarm: number; // 每个 empty 空壳数，默认 1
  requestTimeoutMs: number; // 单请求超时，默认 30_000
  defaultPermissions: Deno.PermissionOptions; // 默认 {}，脚本文件 read 自动追加
  residentConcurrency: number; // 单脚本常驻 Worker 上限，默认 4
  residentIdleMs: number; // 空闲 Worker 回收，默认 30_000，负=不回收；最后一个按 5 倍
}
```

两套 key，不要混：

- `workerKey = JSON.stringify(权限)`：空壳与脚本无关，预热池按它分组
- `residentKey = workerKey + "|" + scriptPath`：常驻槽必须带路径，否则 `read=*` 时不同脚本会共用一个
  Worker

生命周期：

- **ephemeral**（无 default 导出）：每请求新建 Worker，结束后 `terminate()`；
  请求结束后异步补一个已就绪的空壳，下次同 `workerKey` 直接命中，省掉约 8ms isolate 初始化。
  空壳总数受 `maxWorkers` 约束，并且空闲超过 `residentIdleMs` 也会被清扫（懒检查 +
  定时器），避免每种权限配置各攒一个把内存撑大
- **resident**（有 `default.fetch`）：按需扩容的 Worker 池，见下节
- 同时运行数达 `maxWorkers` → 排队；超时的 Worker 直接 `terminate()`，请求返回 504

### 常驻并发池

单个 Worker 内部**必须串行**：CGI 上下文注入改的是 `globalThis.Deno` / `console`，
两个请求同时跑会互相污染。所以并发只能靠多个 Worker。

调度顺序：全局许可 → 脚本信号量（`residentConcurrency`）→ 挑 `pending === 0` 的 Worker → 全忙则扩容
→ 到上限则排队。

先把全局许可拿到再等脚本信号量，保证不会出现“持着信号量干等全局槽”的白占。

其他两个必需的保护：

- **创建锁** `#createLocks`：并发首请求若各自走一遍加载路径，会建出多个 pool 互相覆盖， Worker
  泄漏。现在同一个 `residentKey` 只有第一个请求加载，其余 `await` 它拿到 pool 后自己执行
- **空闲回收**：多余的空闲 Worker 超过 `residentIdleMs` 就 terminate；**最近用过的那个
  （“最后一个”）按 5 倍阈值**，避免热脚本刚冷下来就被回收。全空后从 `#resident` 摧掉、 停掉
  revalidator，下次请求重新 bootstrap（多付 ~30 ms）。
  调度按「最早到期的空闲槽」算，不轮询；已有定时器但新到期时间更早时会被重排—— 否则 bootstrap 挂的 5
  倍定时器会把后续扩容出来的槽拖到很晚才回收

实测 `await sleep(500)` 的接口：4 并发 495 ms，8 并发（上限 4）1074 ms。

### 热重载

两种形态机制不同：

| 形态      | 机制                                                | 生效延迟   |
| --------- | --------------------------------------------------- | ---------- |
| ephemeral | 新 isolate 模块缓存为空，自动重读文件               | 下一个请求 |
| resident  | 后台定时器 `stat` 比较 `mtime`+`size`，变了就 evict | ≤ 2 秒     |

常驻模式对齐 PHP opcache 的默认语义（`validate_timestamps=1`、`revalidate_freq=2`）： **每 2 秒**在
`setInterval` 里异步 `stat` 一次，请求路径上不做任何文件系统调用。

为什么不在请求路径上 `stat`：单次 28 µs 虽然不贵，但它的收益（生效延迟从 2 秒变成 1 个请求）
对开发体验的提升很有限，反而给每个生产请求都加了一次 syscall。后台校验把两者都顾上了。

细节：

- 有请求在跑（`pending > 0`）就跳过本轮，避免 terminate 掉正在执行的 Worker
- `stat` 失败（文件被删）也视为 stale
- 定时器只在存在常驻池时运行，`#resident` 空时自动 `clearInterval`
- 池被后台校验丢弃时，在信号量里排队的请求会收到 `PoolDisposedError`，`run()` 重新走一轮
- evict 后首个请求回到 ~30 ms（重新加载模块），之后又变回 1–2 ms

---

## 7. 权限模型

```
主进程 CLI 权限  = 全局上限（--allow-read / --allow-net ...）
默认权限         = {}，但自动追加 DOCUMENT_ROOT 的 read
路由覆盖         = FCGI_ALLOW_* 与默认值合并（见下表）
```

`read` 默认是整个 `DOCUMENT_ROOT`（边界就是上面路由用的那个值），所以脚本能加载自己、
`import "./x.php"`、读同站点的模板/配置，但读不到站点之外的东西。

早期实现只放行单个脚本文件，导致本地 import 不可用。现在的合并规则：

| `FCGI_ALLOW_READ` | 最终 `read`                                               |
| ----------------- | --------------------------------------------------------- |
| 未配              | `[DOCUMENT_ROOT]`                                         |
| `none` / `false`  | `[scriptPath]`（至少能加载自己，否则 bootstrap 跑不起来） |
| 具体路径列表      | 用户列表 + `scriptPath`（**不**额外叠加 webroot）         |
| `*` / `all`       | 全放开                                                    |

Caddy 侧在 `transport fastcgi` 块里用 `env` 声明（每条路由可不同）：

```caddyfile
@api path /api/*
reverse_proxy @api unix//run/deno-fcgi.sock {
    transport fastcgi {
        split .php
        env FCGI_ALLOW_READ /srv/site/public
        env FCGI_ALLOW_NET api.github.com,127.0.0.1:5432
    }
}
```

| 变量                                  | 取值                 | 说明       |
| ------------------------------------- | -------------------- | ---------- |
| `FCGI_ALLOW_READ`                     | 逗号分隔路径         | 文件读取   |
| `FCGI_ALLOW_WRITE`                    | 逗号分隔路径         | 文件写入   |
| `FCGI_ALLOW_NET`                      | `host` / `host:port` | 网络       |
| `FCGI_ALLOW_ENV`                      | 逗号分隔变量名       | `Deno.env` |
| `FCGI_ALLOW_RUN`                      | 逗号分隔命令         | 子进程     |
| `FCGI_ALLOW_SYS`                      | 逗号分隔能力名       | 系统信息   |
| `FCGI_ALLOW_FFI` / `HREAD` / `HWRITE` | 逗号分隔             | FFI 与句柄 |

取值还支持：`*` / `all` 表示全放开，`none` / 空串表示禁止。

> ⚠️ 不要用 JSON 写 `FCGI_PERMISSIONS`：Caddyfile 会把 `{...}` 当成 placeholder 吃掉。JSON
> 形式仍保留，用于从环境变量 / 外部注入的场景。

- 只要出现了任意一个 `FCGI_ALLOW_*`，未列出的权限类型均被拒绝（Deno 的默认语义）
- Worker 的 entry（`src/runtime/worker-entry.ts`）由主进程加载，**不占** Worker 的 read 额度；
  Worker 的 `read` 只影响脚本体及其 `import`
- 所有 `FCGI_*` 变量不会注入给脚本
- Worker 池 key 包含权限，权限变化自动分组
- 缺省（一个不传）= 零权限，read 自动获得整个 `DOCUMENT_ROOT`
- 解析失败 → 500 + stderr
- Worker 创建时传 `deno: { permissions }`，实测降级生效、提权被拒
- 需要启动时加 `--unstable-worker-options`；缺失时整个请求会失败，启动时应告警

---

## 8. Caddy 配置

脚本必须放在 Caddy 的 webroot 下。

```
/srv/site/public/
  index.php           ← 目录索引
  api/hello.php
  static.html
```

```caddyfile
example.com {
    root * /srv/site/public
    php_fastcgi unix//run/deno-fcgi.sock
    file_server
}
```

`php_fastcgi` 的默认约定正好契合我们的多脚本模型：`split .php`、`index.php` 兜底、
目录补尾斜杠。实测行为：

| 请求             | 结果                                                |
| ---------------- | --------------------------------------------------- |
| `/`              | 200，执行 `index.php`                               |
| `/api.php`       | 200                                                 |
| `/api.php/extra` | 200，`PATH_INFO=/extra`                             |
| `/nope.php`      | 200，兜底执行 `index.php`                           |
| `/missing.css`   | 200，同样兜底执行 `index.php`（PHP 前端控制器模式） |

需要真正的 404 就给 `try_files` 加 `=404`（配置多一行）。

两点限制：

- 转发匹配器是 `path *.php`，没有任何静态防泄露措施。站点里不能混入 `.ts` / `.js`
  源文件，否则会被 `file_server` 当静态文件下发。
- `read` 默认放行整个 `DOCUMENT_ROOT`，脚本可以 `import "./helper.php"`，
  `import.meta.url` 是正常的 `file://` URL，可用于定位自身。

### 需要按目录降权时

`php_fastcgi` 不能按路径传 `FCGI_ALLOW_*`，这时把路由展开写：

```caddyfile
@secure path /secure/*.php*
reverse_proxy @secure unix//run/deno-fcgi.sock {
    transport fastcgi {
        split .php
        capture_stderr
        env FCGI_ALLOW_READ /srv/site/public/secure
    }
}

@scripts {
    path *.php*
    not path /secure/*
}
reverse_proxy @scripts unix//run/deno-fcgi.sock {
    transport fastcgi {
        split .php
        capture_stderr
    }
}
```

- `*.php*` 里的 `*` 不能省，否则带 PATH_INFO 的请求（`/a.php/foo`）不会进来
- `env` 要写在 `transport fastcgi` 块内，值里不要出现 `{...}`（会被当 placeholder）
- `capture_stderr` 同样属于 `transport fastcgi` 块
- **不要再加 `@scriptFiles` + `rewrite {file_match.relative}`**：配合 `split_path .php` 时它会把
  `.php` 切掉，导致裸脚本路径（如 `/api/hello.php`）rewrite 成 `/api/hello` 后不再匹配
  `*.php*`，落到 `file_server` 返回 404（且时好时坏）。`split .php` 已经在 transport 层
  负责拆分 `SCRIPT_FILENAME` / `PATH_INFO`，不需要 rewrite。

---

## 9. 项目结构

```
deno.json
src/
  main.ts              CLI 入口：参数解析、监听、信号处理
  bytes.ts             字节拼接、跨线程 transfer 判定
  router.ts            SCRIPT_FILENAME 解析、路径安全校验
  types.ts             ScriptJob / ScriptResult 等跨线程结构
  fcgi/
    protocol.ts        帧常量、编码、解码
    response.ts        CGI 输出解析与序列化
    server.ts          连接生命周期 + 多路复用状态机
  runtime/
    context.ts         Worker 内 CGI 上下文注入（env/stdin/stdout/console）
    pool.ts            实例池、并发、空闲回收、热重载
    worker-entry.ts    Worker 入口：接收请求、执行脚本、回传输出
examples/
  php-site/public/...  .php 站点示例（内容是 JS）
  caddy/minimal.Caddyfile
tests/
  protocol_test.ts
  response_test.ts
  router_test.ts
```

---

## 10. 里程碑

| 阶段 | 内容                                        | 验收                                          |
| ---- | ------------------------------------------- | --------------------------------------------- |
| M1   | 协议编解码 + 单脚本 + unix socket           | `curl` 经 Caddy 拿到脚本输出                  |
| M2   | 多脚本路由 + `PATH_INFO` + `index.php`      | `/api/hello.php`、`/foo.php/bar` 同时可用   |
| M3   | 权限降级 + 池化 + 空闲淘汰 + 热重载         | 越权读文件被拒；改脚本免重启生效              |
| M4   | 流式响应 + 错误处理 + 日志 + `deno compile` | 大响应不 OOM；脚本异常返回 500 且 stderr 有栈 |

---

## 11. 风险与限制

| 风险                                | 影响                                 | 对策                                                       |
| ----------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| `--unstable-worker-options`         | 未来版本可能改标志名                 | 启动时探测，缺失则退化为「不降权」并告警                   |
| `Deno.env` 进程级共享               | 脚本用 `Deno.env.get` 拿不到请求变量 | 已通过替换 `globalThis.Deno` 为 Proxy 解决                 |
| 每请求新建 isolate 有启动开销       | 首字节变慢                           | 实测 ~9ms；V8 code cache 会复用编译产物                    |
| 顶层执行式不保留进程内状态          | 每次请求重连 DB                      | 与 PHP 一致；需要连接池请改用 `export default { fetch }`   |
| 常驻形态共享模块状态                | 并发写同一份状态需要自己加锁         | 同一 Worker 内请求串行执行；不改 Worker 之间的共享         |
| resident 大响应全量缓冲             | 超大文件占内存                       | 目前读成 arrayBuffer 再回传（transfer 免拷贝，但未免内存） |
| Caddy FastCGI 不支持 chunked 请求体 | 大文件上传受限                       | 文档说明；用 `request_buffers unlimited` 或改走 HTTP 反代  |
| 只能跑 `.php`（内容是 JS）          | 不能直接写 TS                        | 先 bundle 成 JS 再命名为 `.php` 部署                       |

---

## 12. 已确认的决策

| 决策            | 结论                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| 脚本形态        | 两种自动识别：`export default { fetch }` 常驻复用；顶层执行式每请求新建        |
| 执行模型        | 常驻 1–2 ms；顶层执行式每请求重建 Worker（~30 ms），模块状态不跨请求           |
| `Deno.env` 兼容 | Proxy 注入，每请求指向当前请求的 env                                           |
| 权限边界        | `DOCUMENT_ROOT` 同时当路径与边界，不需要额外目录配置                           |
| 读权限默认值    | 整个 `DOCUMENT_ROOT`，本地 `import "./x.php"` 可用                             |
| 权限配置位置    | 由 Caddy `env FCGI_ALLOW_*` 传入（逗号分隔，避免 JSON 花括号被当 placeholder） |
| 脚本扩展名      | **只认 `.php`**，内容是 JavaScript；需要 TS 就先 bundle 再命名 `.php`           |

## 13. 为什么只支持 `.php`

Deno 按扩展名判定模块类型，`.php` 会被当作 **JavaScript** 解析。固定单一扩展名的好处：

- 「URL → 可执行文件」映射唯一，Caddy 侧基于 URL 的 `path` / `hide` 规则能覆盖每一个可执行脚本
- 不会出现「同一个逻辑换个后缀就能绕过访问控制」的路径
- 与 `php_fastcgi` 这类内置简写天然兼容

代价是**不能直接写 TypeScript**。需要 TS 的话先 bundle 成 JS，再命名为 `xxx.php` 部署：

```bash
deno bundle src/api/hello.ts public/api/hello.php   # 具体命令按 bundler 而定
```

早期版本支持 `.ts` / `.tsx` / `.js` / `.mjs` / `.jsx`，但在“文件不存在时追加扩展名重试”
的配合下，URL 与实际执行文件会脱钩，因此一并移除。
