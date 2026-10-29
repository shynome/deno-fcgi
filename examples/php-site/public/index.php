// .php 后缀的最小配置示例。
// 注意：Deno 只能把 .php 当 JavaScript 解析，所以这里不能写 TS 类型注解。
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

app.get("/", (c) =>
  c.html(
    `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>deno-fcgi (.php)</title>
<style>body{font-family:system-ui,sans-serif;max-width:620px;margin:60px auto;padding:0 20px}</style>
</head>
<body>
  <h1>deno-fcgi / .php</h1>
  <p>SCRIPT_NAME = <code>${process.env.SCRIPT_NAME}</code></p>
  <ul>
    <li><a href="/api.php">/api.php</a></li>
  </ul>
</body>
</html>`,
  ));

app.notFound((c) => c.text("Not Found", 404));

await handlecgi(app, process.env);
