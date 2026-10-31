// /api/hello.php?name=deno
// /api/hello.php/users/42  -> PATH_INFO 为 /users/42
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

app.get("/", (c) =>
  c.json({
    hello: c.req.query("name") ?? "world",
    method: process.env.REQUEST_METHOD,
    scriptName: process.env.SCRIPT_NAME,
    pathInfo: process.env.PATH_INFO || null,
  }));

app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));

await handlecgi(app, process.env);
