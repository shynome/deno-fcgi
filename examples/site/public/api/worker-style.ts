// export default { fetch } 形式（Deno.serve / Hono 风格）
// 首次请求加载后 Worker 常驻，后续请求直接复用，省掉 isolate 初始化。
//
// 注意：这里的 Request URL 是完整的 REQUEST_URI（含脚本名），
// 所以用 basePath 把脚本路径剥掉。
import { Hono } from "npm:hono@^4";

const app = new Hono().basePath("/api/worker-style.ts");

app.get("/", (c) =>
  c.json({
    mode: "export default { fetch }",
    path: c.req.path,
    script: process.env.SCRIPT_NAME,
  }));

app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));

export default app;
