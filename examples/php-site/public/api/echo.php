// POST /api/echo.ts —— 回显请求体
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

app.all("/", async (c) => {
  const body = await c.req.text();
  return c.json({
    method: process.env.REQUEST_METHOD,
    contentType: process.env.CONTENT_TYPE ?? null,
    length: body.length,
    body,
    pathInfo: process.env.PATH_INFO || null,
  });
});

await handlecgi(app, process.env);
