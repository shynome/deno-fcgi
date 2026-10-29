// 目录索引页：/ -> 这个文件
// hono-cgi-adapter 把 PATH_INFO 当作请求路径，所以这里注册的是 "/"
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

app.get("/", (c) =>
  c.html(
    `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>deno-fcgi</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:680px;margin:60px auto;padding:0 20px;color:#1f2328}
  code{background:#f6f8fa;padding:2px 6px;border-radius:4px}
  li{margin:6px 0}
</style>
</head>
<body>
  <h1>deno-fcgi</h1>
  <p>脚本由 <code>hono-cgi-adapter</code> 驱动，SCRIPT_NAME = <code>${process.env.SCRIPT_NAME}</code></p>
  <ul>
    <li><a href="/api/hello.ts?name=deno">/api/hello.ts?name=deno</a></li>
    <li><a href="/api/hello.ts/users/42">/api/hello.ts/users/42</a>（PATH_INFO 子路由）</li>
    <li><a href="/api/hono.ts">/api/hono.ts</a>（完整 Hono 示例）</li>
    <li><a href="/api/">/api/</a>（目录索引）</li>
    <li><a href="/secure/perm.ts">/secure/perm.ts</a>（权限降级）</li>
    <li><a href="/static.html">/static.html</a>（不进 Deno 的静态文件）</li>
  </ul>
</body>
</html>`,
  ));

app.notFound((c) => c.text("Not Found", 404));

await handlecgi(app, process.env);
