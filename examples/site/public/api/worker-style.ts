// export default { fetch } 形式（Deno.serve / Hono 风格）
// 首次请求加载后 Worker 常驻，后续请求直接复用，省掉 isolate 初始化。
//
// Request URL 的 path 是 PATH_INFO（脚本名已被剥掉），和 CGI 模式一致，
// 所以路由直接写应用内路径，不需要 basePath。
// 需要原始完整地址时读 process.env.REQUEST_URI。
import { Hono } from "npm:hono@^4";

const app = new Hono();

app.get("/", (c) =>
  c.json({
    mode: "export default { fetch }",
    path: c.req.path,
    url: c.req.url,
    requestUri: process.env.REQUEST_URI,
    script: process.env.SCRIPT_NAME,
  }));

app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));

export default app;
