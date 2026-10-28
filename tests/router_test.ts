import { normalizePath, RouteError, Router, splitOnScriptExtension } from "../src/router.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ?? "assertion failed"}: ${a} !== ${b}`);
}

Deno.test("normalizePath 折叠 . 与 ..", () => {
  assertEquals(normalizePath("/a/./b/../c"), "/a/c");
  assertEquals(normalizePath("/../../etc/passwd"), "/etc/passwd");
  assertEquals(normalizePath("a//b/"), "a/b");
});

Deno.test("splitOnScriptExtension 切出 PATH_INFO", () => {
  assertEquals(splitOnScriptExtension("/srv/api/hello.ts/foo/bar"), {
    script: "/srv/api/hello.ts",
    rest: "/foo/bar",
  });
  assertEquals(splitOnScriptExtension("/srv/index.ts"), null);
});

Deno.test("Router 解析存在的脚本", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/api`, { recursive: true });
  await Deno.writeTextFile(`${root}/index.ts`, "");
  await Deno.writeTextFile(`${root}/api/hello.ts`, "");

  const router = new Router();
  const route = await router.resolve({
    SCRIPT_FILENAME: `${root}/api/hello.ts`,
    SCRIPT_NAME: "/api/hello.ts",
    DOCUMENT_ROOT: root,
  });
  assertEquals(route.scriptName, "/api/hello.ts");
  assertEquals(route.pathInfo, "");

  const index = await router.resolve({
    SCRIPT_FILENAME: `${root}/`,
    SCRIPT_NAME: "/",
    DOCUMENT_ROOT: root,
  });
  assertEquals(index.scriptPath.endsWith("/index.ts"), true);

  await Deno.remove(root, { recursive: true });
});

Deno.test("Router 拒绝越界与不存在", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  await Deno.writeTextFile(`${outside}/evil.ts`, "");
  await Deno.writeTextFile(`${root}/index.ts`, "");
  const router = new Router();

  // 脚本在 DOCUMENT_ROOT 之外 → 403
  let status = 0;
  try {
    await router.resolve({
      SCRIPT_FILENAME: `${outside}/evil.ts`,
      DOCUMENT_ROOT: root,
    });
  } catch (error) {
    status = error instanceof RouteError ? error.status : -1;
  }
  assertEquals(status, 403);

  // 没传 DOCUMENT_ROOT → 无权判断边界，同样拒绝
  status = 0;
  try {
    await router.resolve({ SCRIPT_FILENAME: `${root}/index.ts` });
  } catch (error) {
    status = error instanceof RouteError ? error.status : -1;
  }
  assertEquals(status, 403);

  status = 0;
  try {
    await router.resolve({
      SCRIPT_FILENAME: `${root}/missing.ts`,
      DOCUMENT_ROOT: root,
    });
  } catch (error) {
    status = error instanceof RouteError ? error.status : -1;
  }
  assertEquals(status, 404);

  await Deno.remove(root, { recursive: true });
  await Deno.remove(outside, { recursive: true });
});

Deno.test("Router 拒绝非脚本扩展名", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/secret.txt`, "x");
  const router = new Router();

  let status = 0;
  try {
    await router.resolve({
      SCRIPT_FILENAME: `${root}/secret.txt`,
      DOCUMENT_ROOT: root,
    });
  } catch (error) {
    status = error instanceof RouteError ? error.status : -1;
  }
  assertEquals(status, 403);

  await Deno.remove(root, { recursive: true });
});
