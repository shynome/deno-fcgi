// 权限降级演示：Caddyfile 里这个目录被限制为只能读 ./secure
// 预期结果：systemFile / network 为 NotCapable，webrootFile 为 allowed
import { Hono } from "npm:hono@^4";
import { handlecgi } from "npm:hono-cgi-adapter";

const app = new Hono();

async function probe(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "allowed";
  } catch (error) {
    return (error as Error).name;
  }
}

// 注意：脚本以 data: URL 执行，import.meta.url 不可用于解析相对路径，
// 这里用 CGI 变量拼出绝对路径
const dataFile = `${process.env.DOCUMENT_ROOT}/secure/data.txt`;

app.get("/", async (c) =>
  c.json({
    systemFile: await probe(() => Deno.readTextFile("/etc/hostname")),
    webrootFile: await probe(() => Deno.readTextFile(dataFile)),
    network: await probe(() => Deno.connect({ hostname: "example.com", port: 80 })),
  }));

await handlecgi(app, process.env);
