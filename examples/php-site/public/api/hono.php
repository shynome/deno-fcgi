// 完整一点的 Hono 用法：中间件、路由组、JSON body、404、错误处理
import { Hono } from "npm:hono@^4";
import { getConnInfoOnCGI, handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

// 请求计时中间件
app.use("*", async (c, next) => {
  const start = performance.now();
  await next();
  c.header("X-Elapsed-Ms", (performance.now() - start).toFixed(1));
});

app.get("/", (c) => c.text("Hello from Hono CGI"));

app.get("/info", (c) =>
  c.json({
    conn: getConnInfoOnCGI(c),
    script: process.env.SCRIPT_NAME,
    pathInfo: process.env.PATH_INFO || null,
    method: process.env.REQUEST_METHOD,
  }));

const users = new Hono();
users.get("/:id", (c) => c.json({ id: c.req.param("id") }));
users.post("/", async (c) => {
  const payload = await c.req.json().catch(() => null);
  return c.json({ created: true, payload }, 201);
});
app.route("/users", users);

app.notFound((c) => c.text(`Hono 404: ${c.req.path}`, 404));

app.onError((error, c) => c.json({ error: error.message }, 500));

await handlecgi(app, process.env);
