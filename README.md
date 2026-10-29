# deno-fcgi

给 Deno 脚本用的 FastCGI 服务端，放在 Caddy 后面用。

和 PHP 一样：**URL 路径直接对应磁盘上的脚本文件**，新增脚本不用改配置、不用重启服务。

```ts
// public/api/hello.ts
import { Hono } from "npm:hono@^4";

const app = new Hono();

app.get("/", (c) => c.text("hello " + (c.req.query("name") ?? "world")));
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));

export default app;
```

```bash
curl 'http://localhost:8080/api/hello.ts?name=deno'
# hello name=deno

curl 'http://localhost:8080/api/hello.ts/users/42'
# {"id":"42"}
```

> 也可以不依赖任何库，直接写裸 CGI 脚本（`console.log` 输出响应头与 body）， 见下方「脚本怎么写」。

## 特性

- 标准 FastCGI responder，一条连接上支持多请求复用
- 多脚本路由：`/a/b.ts`、`/dir/`（→ `dir/index.ts`）、`/a/b.ts/extra`（PATH_INFO）
- 真正的 CGI 语义：每次请求一个全新 Worker isolate，脚本顶层代码重新执行
- 脚本里直接用 `process.env`、`console.log`、`Deno.stdin` 读写 CGI 数据
- 两种脚本形态：`export default { fetch }`（常驻复用）与顶层执行式（PHP 风格）
- 默认零权限，只自动放行 `DOCUMENT_ROOT` 的 `read`；联网 / 写 / 子进程需显式放开
- 脚本可以 `import "./helper.ts"`、读同一站点里的模板和配置
- `deno compile` 可打包成单文件二进制

## 快速开始

```bash
# 1. 启动 FastCGI 服务端
# 不需要 --root：默认以 Caddy 传来的 DOCUMENT_ROOT 为边界
deno run --allow-read --allow-net --allow-env --allow-write \
  --unstable-worker-options \
  jsr:@shynome/deno-fcgi \
  --listen unix:/run/deno-fcgi.sock

# 2. Caddy 侧
```

```caddyfile
example.com {
	root * /srv/site/public

	route {
		@canonicalPath {
			file {path}/index.ts
			not path */
		}
		redir @canonicalPath {http.request.orig_uri.path}/ 308

		@scriptFiles file {
			try_files {path} {path}/index.ts
			try_policy first_exist_fallback
			split_path .ts
		}
		rewrite @scriptFiles {file_match.relative}

		@scripts path *.ts*
		reverse_proxy @scripts unix//run/deno-fcgi.sock {
			transport fastcgi {
				split .ts
				capture_stderr
			}
		}
	}

	file_server {
		hide *.ts *.tsx *.jsx
	}
}
```

> - `*.ts*` 里的 `*` 不能省，否则带 PATH_INFO 的请求（`/a.ts/foo`）不会进来
> - `.ts` 不能用 `php_fastcgi` 简写，它对 `/` 的 try_files 会拼出 `//index.ts` 导致 404

### 最小配置：`.php` 后缀

如果想让 Caddyfile 尽量短，把脚本命名为 `.php`：

```caddyfile
:8081 {
	root * /srv/site/public
	php_fastcgi unix//run/deno-fcgi.sock
	file_server
}
```

`php_fastcgi` 自带 `split .php`、`index.php` 兜底和目录重定向，所以只要三行。 示例见
`examples/caddy/minimal.Caddyfile` 与 `examples/php-site/`。

代价：

| 项目         | 说明                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 模块类型     | Deno 只把 `.php` 按 **JavaScript** 解析，不能写 TS 类型注解                                                                                                  |
| PATH_INFO    | 正常：`/api.php/extra` → `PATH_INFO=/extra`                                                                                                                  |
| 未匹配的路径 | 所有未命中的路径（含 `.php` 和静态文件）都会执行 `index.php` 并返回 200——这是 PHP 前端控制器模式；需要真的 404 就加 `try_files {path} {path}/index.php =404` |

`.php` 会被 Deno 按 **JavaScript** 解析——直接把编译后的 JS 放进去就行。

## 脚本怎么写

Worker 的 `read` 权限默认是整个 **`DOCUMENT_ROOT`**，所以脚本可以 `import "./helper.ts"`、
读取同一站点里的模板 / 配置文件，但读不到站点之外的任何东西。

支持两种形态，宿主自动识别：

| 形态                       | 判定               | Worker     | 热门请求耗时 |
| -------------------------- | ------------------ | ---------- | ------------ |
| `export default { fetch }` | 有 `default.fetch` | 常驻复用   | **1–2 ms**   |
| 顶层执行式（CGI 风格）     | 无 default 导出    | 每请求新建 | ~30 ms       |

### 方式一：`export default`（推荐）

与 `Deno.serve` / Cloudflare Workers 的写法一致，Hono 实例本身就有 `fetch`：

```ts
import { Hono } from "npm:hono@^4";

const app = new Hono();

app.get("/", (c) => c.text("hello"));
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));

export default app; // 等价于 export default { fetch: app.fetch }
```

Request URL 的 path 取 `PATH_INFO`（`SCRIPT_NAME` 已被 Caddy 的 `split` 剥掉）， query 取
`QUERY_STRING`，和顶层执行式 / `hono-cgi-adapter` 看到的一致： 浏览器访问
`/api/hello.ts/users/42` 时，`c.req.path` 就是 `/users/42`，所以 **不需要 `basePath`**。
需要原始完整地址（含脚本名）时读 `process.env.REQUEST_URI`。

这种形态下模块只加载一次，Worker 常驻，后续请求只需构造 Request 并调用 `fetch`。
代价是进程内状态（连接池、缓存）会在请求间共享，需要自己考虑并发安全。

### 方式二：顶层执行（PHP 风格）

脚本就是一个普通的 Deno 脚本，顶层代码即请求逻辑：

```ts
// public/api/echo.ts
const body = await new Response(Deno.stdin.readable).text();

console.log("Content-Type: application/json; charset=utf-8");
console.log("");
console.log(JSON.stringify({
  method: process.env.REQUEST_METHOD,
  pathInfo: process.env.PATH_INFO,
  body,
}));
```

宿主注入的内容：

| 注入                                             | 说明                                              |
| ------------------------------------------------ | ------------------------------------------------- |
| `process.env` / `Deno.env`                       | 本次请求的 CGI 变量                               |
| `Deno.stdin` / `process.stdin`                   | 请求体                                            |
| `Deno.stdout` / `console.log` / `process.stdout` | 响应输出                                          |
| `Deno.stderr` / `console.error`                  | 会写进 FCGI_STDERR，Caddy `capture_stderr` 可记录 |

响应格式就是 CGI：先输出头，空行后是 body。

```ts
console.log("Status: 404 Not Found");
console.log("Content-Type: text/html");
console.log("");
console.log("<h1>not found</h1>");
```

`process.exit()` / `Deno.exit()` 会被拦截成"提前结束本次响应"，不会杀掉服务。

## 热更新

顶层执行式天然热更新：每请求都是新 isolate，改文件后下一次请求就生效。

常驻（`export default`）脚本的行为对齐 PHP opcache：后台每 **2 秒**异步 `stat` 一次脚本文件 （对应
`opcache.revalidate_freq=2`），发现 `mtime` 或 `size` 变化就丢掉旧 Worker， 下一次请求重新加载。

检查在定时器里跑，**请求路径上没有任何文件系统调用**，不会拖慢响应。改完代码后大概刷新 2–3 次
就能看到新版本。

evict 后首个请求会回到 ~30 ms（模块重新加载），之后又变回 1–2 ms。 同一脚本有请求在跑时本轮不
evict，等它结束后的下一个周期再判。

定时器只在存在常驻脚本时运行，没有常驻脚本就自动停掉。

## 并发

顶层执行式每请求一个新 Worker，天然并行，受 `--max-workers` 限制。

常驻脚本按需扩容：同一脚本最多保留 `--resident-concurrency` 个 Worker（默认 4）。

- 有空闲 Worker → 直接复用
- 全忙且未到上限 → 新建一个（首个请求多付 ~30 ms 加载）
- 已到上限 → 排队等空闲

单个 Worker 内部**始终串行**：注入的 CGI 上下文（`Deno.env`、`stdout` 等）是全局对象，
两个请求同时跑会互相污染。所以「并发」= 多个 Worker 并行，而不是一个 Worker 多路复用。

多余的 Worker 空闲 `--resident-idle`（默认 30s）后回收。**最后一个也会被回收**： 脚本 30
秒没人访问就把整个池释放掉，下次首个请求重新加载（多付 ~30 ms）。
想让它一直热着就把这个值调大，设成负数则彻底不回收。

```
--resident-concurrency 4     单脚本常驻 Worker 上限
--resident-idle 30000        多余 Worker 空闲回收时间，负数=不回收
```

实测一个 `await sleep(500)` 的接口：4 个并发请求总耗时 **495 ms**（串行会是 2000 ms）， 6 个并发
**420 ms**（降到 4 个一批）。

## 配合 Hono 使用

`examples/` 下的所有脚本都基于 [hono-cgi-adapter](https://github.com/taisan11/hono-cgi-adapter)，
可以把现有 Hono 应用直接搬过来：

```ts
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

app.get("/", (c) => c.text("Hello from Hono CGI"));
app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
app.post("/echo", async (c) => c.json({ body: await c.req.text() }));

await handlecgi(app, process.env);
```

示例目录：

| 文件             | 演示内容                                     |
| ---------------- | -------------------------------------------- |
| `index.ts`       | HTML 索引页                                  |
| `api/hello.ts`   | 查询参数 + PATH_INFO 子路由                  |
| `api/echo.ts`    | POST 请求体                                  |
| `api/index.ts`   | 目录索引                                     |
| `api/hono.ts`    | 中间件 / 路由组 / JSON body / 404 / onError  |
| `secure/perm.ts` | 权限放开（配合 Caddyfile 的 `FCGI_ALLOW_*`） |

该适配器只用 `PATH_INFO` 当请求路径，所以：

| 浏览器访问              | Hono 看到的路径 |
| ----------------------- | --------------- |
| `/api/hono.ts`          | `/`             |
| `/api/hono.ts/users/42` | `/users/42`     |

两个需要留意的地方：

- 它**不会把 `QUERY_STRING` 拼进 URL**，需要自己在脚本里解析：
  `new URLSearchParams(process.env.QUERY_STRING ?? "")`
- 它输出响应时会把 `Status` 头一并写出，宿主会解析后重新序列化，不会透传给客户端

宿主已为其补齐 Node 兼容层：全局 `Buffer`、`process.stdout.push`、 `process.stdin` 的 async
iterator、`process.env`。

> 模块下载与缓存读取由 Deno 加载器负责，**不受脚本权限约束**，所以 npm/jsr 依赖
> 在降权目录里也能正常加载。`FCGI_ALLOW_NET` 只影响脚本运行时的 `fetch`， `FCGI_ALLOW_READ` 只影响
> `import "./local.ts"` 这类本地模块。

## 权限控制

**默认是零权限**：不写任何 `FCGI_ALLOW_*` 时，脚本不能读文件、不能联网、不能写文件、不能起子进程。

```
主进程 CLI 权限（上限）
   └── 默认：全部拒绝
          └── 每个路由的 FCGI_ALLOW_* 按需放开
```

Worker 只能拿主进程权限的子集，尝试提权会报 `Can't escalate parent thread permissions`。

### 在 Caddy 里放开

写在 `transport fastcgi` 块内，每个路由可以不同：

```caddyfile
@api path /api/*
reverse_proxy @api unix//run/deno-fcgi.sock {
	transport fastcgi {
		split .ts
		env FCGI_ALLOW_READ /srv/site/public
		env FCGI_ALLOW_NET api.github.com,127.0.0.1:5432
	}
}
```

| 变量                                          | 对应 `Deno.PermissionOptions` | 取值                  |
| --------------------------------------------- | ----------------------------- | --------------------- |
| `FCGI_ALLOW_READ` / `WRITE`                   | `read` / `write`              | 逗号分隔路径          |
| `FCGI_ALLOW_NET`                              | `net`                         | `host` 或 `host:port` |
| `FCGI_ALLOW_ENV`                              | `env`                         | 逗号分隔变量名        |
| `FCGI_ALLOW_RUN`                              | `run`                         | 逗号分隔命令          |
| `FCGI_ALLOW_SYS` / `FFI` / `HREAD` / `HWRITE` | 同名                          | 逗号分隔              |

取值还支持 `*` / `all` / `true`（全放开）和 `none` / 空串 / `false`（禁止）。

### 要点

- 默认权限是 `{}`，但 Worker 会自动获得整个 `DOCUMENT_ROOT` 的 `read`（不配什么都能跑）。
- 显式写了 `FCGI_ALLOW_READ` 时，以你的为准（不再叠加 webroot），但仍保证脚本自己能加载。
- **未列出的权限类型全部拒绝**（Deno 的语义）。只写 `FCGI_ALLOW_READ`
  就等于同时禁掉了网络、写文件、子进程。
- 所有 `FCGI_*` 变量在注入给脚本前会被剥离，脚本看不到。
- 必须带 `--unstable-worker-options`，否则创建带权限的 Worker 会直接失败。
- 不要用 JSON 写 `FCGI_PERMISSIONS`，Caddyfile 会把 `{...}` 当 placeholder 吃掉 （JSON
  形式只在从环境变量注入时可用）。

### 两个实测结论

- `FCGI_ALLOW_NET` **不影响** npm/jsr 依赖加载——模块下载是加载器行为，不吃 permission。
- `FCGI_ALLOW_ENV` 一般用不上：脚本读到的 `process.env` / `Deno.env` 都是注入的代理对象， 不经过
  Deno 的 env 权限检查。

### 常用配方

```caddyfile
# 默认：脚本只能加载自己（不写任何 FCGI_ALLOW_*）

# 需要读配置文件
env FCGI_ALLOW_READ /srv/site/data

# 需要调外部 API
env FCGI_ALLOW_NET api.github.com

# 读 + 写上传目录
env FCGI_ALLOW_READ /srv/site/data
env FCGI_ALLOW_WRITE /srv/site/uploads
```

`examples/caddy/Caddyfile` 里的 `/secure/` 就是第一个配方：只能读 `public/secure`， 读
`/etc/hostname` 和联网都返回 `NotCapable`。

## CLI

```
-l, --listen <addr>     unix:/path 或 tcp:host:port（默认 unix:/tmp/deno-fcgi.sock）
    --max-workers <n>   并发 Worker 上限（默认 16）
    --prewarm <n>       每个脚本保留的空壳数（默认 1）
    --timeout <ms>      单请求超时（默认 30000）
    --resident-concurrency <n> 单脚本常驻 Worker 上限（默认 4）
    --resident-idle <ms>       空闲 Worker 回收时间（默认 30s，负数=不回收；最后一个按 5 倍）
    --max-body <bytes>  请求体上限（默认 32MB）
    --log-level <level> debug | info | error
```

## 限制

- **Caddy 的 FastCGI 不支持 chunked 请求体**：没有 `Content-Length` 的请求会被 Caddy 直接 411
- 顶层执行式没有进程内状态复用：DB 连接等资源每次请求重建（和 PHP 一致），需要复用请改用
  `export default { fetch }`，或把共享状态放 redis / 数据库
- 常驻 Worker 执行期间脚本会拿到**宿主进程级**的 `Deno.env`，所以隔离性来自每请求新建 Worker；
  选择常驻形态意味着接受同一 Worker 内请求串行、模块状态共享
- 同一 Worker 内的请求是串行的，并发靠多个 Worker（`--resident-concurrency`）； Worker 内存比
  isolate 贵，不建议把这个值开得很大
- `.tsx/.jsx` 需要在启动目录的 `deno.json` 配置 `compilerOptions.jsx`

## 开发

```bash
deno task test
deno task dev --listen unix:/tmp/deno-fcgi.sock

# 另开一个终端
caddy run --config examples/caddy/Caddyfile --adapter caddyfile
```

设计细节见 [design.md](./design.md)。
