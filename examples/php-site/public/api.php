// .php 后缀：只能写纯 JavaScript
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

app.get("/", (c) =>
  c.json({
    script: process.env.SCRIPT_NAME,
    uri: process.env.REQUEST_URI,
    method: process.env.REQUEST_METHOD,
    pathInfo: process.env.PATH_INFO || null,
  }));

app.post("/", async (c) =>
  c.json({
    method: process.env.REQUEST_METHOD,
    received: await c.req.text(),
  }));

await handlecgi(app, process.env);
