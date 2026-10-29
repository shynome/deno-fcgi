// 目录索引：/api/ -> 这个文件
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

app.get("/", (c) =>
  c.json({
    index: true,
    scriptName: process.env.SCRIPT_NAME,
    pathInfo: process.env.PATH_INFO || null,
    entries: ["hello.php", "echo.php", "hono.php", "worker-style.php"],
  }));

await handlecgi(app, process.env);
