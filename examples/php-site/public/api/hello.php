// /api/hello.ts?name=deno
// /api/hello.ts/users/42  -> PATH_INFO 为 /users/42
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

// hono-cgi-adapter 不会把 QUERY_STRING 拼进 URL，需要自己解析
const query = new URLSearchParams(process.env.QUERY_STRING ?? "");

app.get("/", (c) =>
  c.json({
    hello: query.get("name") ?? "world",
    method: process.env.REQUEST_METHOD,
    scriptName: process.env.SCRIPT_NAME,
    pathInfo: process.env.PATH_INFO || null,
  }));

app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));

await handlecgi(app, process.env);
