# Changelog

本项目的所有重要改动都记录在这里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.0] - 2026-10-29

### Changed

- **只支持 `.php` 脚本**（破坏性变更）：`SCRIPT_EXTENSIONS` 收敛为 `[".php"]`，
  `INDEX_FILES` 为 `["index.php"]`。`.ts` / `.tsx` / `.js` / `.mjs` / `.jsx`
  不再被当作可执行脚本（返回 403）。需要 TypeScript 时先 bundle 成 JS，再命名为 `.php` 部署。

  这样「URL → 可执行文件」映射唯一，Caddy 侧基于 URL 的 `path` / `hide` 规则能覆盖每个脚本。

- `examples/site` 下示例全部改名为 `.php`，并合并进 `examples/php-site/public/`；
  `examples/caddy/Caddyfile` 删除，只保留 `examples/caddy/minimal.Caddyfile`（`php_fastcgi` 三行）。

  原展开配置里的 `@scriptFiles` + `rewrite {file_match.relative}` 一并去掉：它配合
  `split_path .php` 会把扩展名切掉，导致裸脚本路径（`/api/hello.php`）偶发 404。

### Removed

- 移除了「文件不存在时按 `SCRIPT_EXTENSIONS` 追加扩展名重试」的行为：`/a/index.php`
  不会再退到 `index.php.ts`，`/foo` 也不会退到 `/foo.ts`，文件不存在就是 404。

  原因是补后缀会让 **URL 与实际执行的文件脱钩**：Caddy 侧基于 URL 的 `hide`、`path`
  访问控制只作用于请求路径，挡不住被追加出来的文件；webroot 里任何 `xxx.php.ts`
  也会经由 `/xxx.php` 直接执行。

  目录索引查找（`/dir/` → `dir/index.php`）不受影响。

### 迁移指南

1. 把站点里的 `.ts` / `.js` 脚本重命名为 `.php`（内容需是 JavaScript，去掉类型注解）
2. 删掉 Caddyfile 里的 `@scriptFiles` + `rewrite {file_match.relative}` 段
3. `split_path` / `split` 全部改为 `.php`，或者直接用 `php_fastcgi`
4. 常驻脚本删掉 `new Hono().basePath("/api/xxx.php")` 里的 `basePath`（0.1.1 起就不需要）

## [0.1.1] - 2026-10-29

### Changed

- **常驻模式的 Request URL 改用 `PATH_INFO`**：`export default { fetch }` 脚本拿到的
  Request 不再包含脚本名，与顶层执行式（CGI）及 `hono-cgi-adapter` 保持一致。
  浏览器访问 `/api/hello.ts/users/42`，框架看到的路径就是 `/users/42`。

  ```ts
  // 之前
  const app = new Hono().basePath("/api/hello.ts");

  // 现在
  const app = new Hono();
  ```

- 常驻模式的 Request URL 现在会补上 `QUERY_STRING`，`c.req.query()` 可直接使用。

### Added

- 客户端未拆分 `PATH_INFO` 时，用 `REQUEST_URI` 减 `SCRIPT_NAME` 兜底，避免路径整体塌回 `/`。

### 迁移提示

- 脚本里 `new Hono().basePath("/api/xxx.ts")` 的 `basePath` 需要删掉，否则路由匹配不到。
- `c.req.url` 不再等于浏览器实际访问的地址（不含脚本名）。需要拼绝对链接或原始路径时，
  读 `process.env.REQUEST_URI` / `Deno.env.get("REQUEST_URI")`，它照旧注入。

## [0.1.0] - 2026-10-29

### Added

- 标准 FastCGI responder，一条连接上支持多请求复用
- 多脚本路由：`/a/b.ts`、`/dir/`（→ `dir/index.ts`）、`/a/b.ts/extra`（PATH_INFO）
- 脚本形态自动识别：`export default { fetch }` 常驻复用，顶层执行式（PHP 风格）每请求新建
- 完整 CGI 语义注入：`process.env`、`process.stdout/stderr/stdin`、`Deno.stdin/stdout/stderr`、
  `Deno.env`、`console`，以及全局 `Buffer`
- 降权运行：默认只放行 `DOCUMENT_ROOT` 的 `read`，联网 / 写 / 子进程用 `FCGI_ALLOW_*` 显式放开
- `deno compile` 可打包成单文件二进制
