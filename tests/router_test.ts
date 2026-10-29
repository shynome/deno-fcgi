import { normalizePath, RouteError, Router, splitOnScriptExtension } from "../src/router.ts";

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ?? "assertion failed"}: ${a} !== ${b}`);
}

async function resolveStatus(router: Router, params: Record<string, string>): Promise<number> {
  try {
    await router.resolve(params);
    return 200;
  } catch (error) {
    return error instanceof RouteError ? error.status : -1;
  }
}

Deno.test("normalizePath 折叠 . 与 ..", () => {
  assertEquals(normalizePath("/a/./b/../c"), "/a/c");
  assertEquals(normalizePath("/../../etc/passwd"), "/etc/passwd");
  assertEquals(normalizePath("a//b/"), "a/b");
});

Deno.test("splitOnScriptExtension 切出 PATH_INFO", () => {
  assertEquals(splitOnScriptExtension("/srv/api/hello.php/foo/bar"), {
    script: "/srv/api/hello.php",
    rest: "/foo/bar",
  });
  assertEquals(splitOnScriptExtension("/srv/index.php"), null);
});

Deno.test("Router 解析存在的脚本", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/api`, { recursive: true });
  await Deno.writeTextFile(`${root}/index.php`, "");
  await Deno.writeTextFile(`${root}/api/hello.php`, "");

  const router = new Router();
  const route = await router.resolve({
    SCRIPT_FILENAME: `${root}/api/hello.php`,
    SCRIPT_NAME: "/api/hello.php",
    DOCUMENT_ROOT: root,
  });
  assertEquals(route.scriptName, "/api/hello.php");
  assertEquals(route.pathInfo, "");

  const index = await router.resolve({
    SCRIPT_FILENAME: `${root}/`,
    SCRIPT_NAME: "/",
    DOCUMENT_ROOT: root,
  });
  assertEquals(index.scriptPath.endsWith("/index.php"), true);

  await Deno.remove(root, { recursive: true });
});

Deno.test("Router 拒绝越界与不存在", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  await Deno.writeTextFile(`${outside}/evil.php`, "");
  await Deno.writeTextFile(`${root}/index.php`, "");
  const router = new Router();

  // 脚本在 DOCUMENT_ROOT 之外 → 403
  assertEquals(
    await resolveStatus(router, {
      SCRIPT_FILENAME: `${outside}/evil.php`,
      DOCUMENT_ROOT: root,
    }),
    403,
  );

  // 没传 DOCUMENT_ROOT → 无权判断边界，同样拒绝
  assertEquals(
    await resolveStatus(router, { SCRIPT_FILENAME: `${root}/index.php` }),
    403,
  );

  assertEquals(
    await resolveStatus(router, {
      SCRIPT_FILENAME: `${root}/missing.php`,
      DOCUMENT_ROOT: root,
    }),
    404,
  );

  await Deno.remove(root, { recursive: true });
  await Deno.remove(outside, { recursive: true });
});

Deno.test("Router 只接受 .php 脚本", async () => {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/secret.txt`, "x");
  await Deno.writeTextFile(`${root}/app.ts`, "x");
  await Deno.writeTextFile(`${root}/app.js`, "x");
  await Deno.writeTextFile(`${root}/app.mjs`, "x");
  const router = new Router();

  for (const file of ["secret.txt", "app.ts", "app.js", "app.mjs"]) {
    assertEquals(
      await resolveStatus(router, {
        SCRIPT_FILENAME: `${root}/${file}`,
        DOCUMENT_ROOT: root,
      }),
      403,
      `${file} 应该被拒绝`,
    );
  }

  // 目录里只有 index.ts，没有 index.php → 找不到索引
  await Deno.mkdir(`${root}/dir`);
  await Deno.writeTextFile(`${root}/dir/index.ts`, "");
  assertEquals(
    await resolveStatus(router, {
      SCRIPT_FILENAME: `${root}/dir/`,
      DOCUMENT_ROOT: root,
    }),
    404,
  );

  await Deno.remove(root, { recursive: true });
});

Deno.test("Router 不为不存在的路径追加扩展名", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/api`, { recursive: true });
  await Deno.writeTextFile(`${root}/index.php`, "");
  await Deno.writeTextFile(`${root}/api/hello.ts`, "");
  const router = new Router();

  // 同名 .ts 存在，也不能让不存在的 hello.php 变成可执行
  assertEquals(
    await resolveStatus(router, {
      SCRIPT_FILENAME: `${root}/api/hello.php`,
      SCRIPT_NAME: "/api/hello.php",
      DOCUMENT_ROOT: root,
    }),
    404,
  );

  // 带 PATH_INFO 的同样不追加
  assertEquals(
    await resolveStatus(router, {
      SCRIPT_FILENAME: `${root}/api/hello.php`,
      SCRIPT_NAME: "/api/hello.php",
      PATH_INFO: "/users/42",
      DOCUMENT_ROOT: root,
    }),
    404,
  );

  // 目录索引查找不受影响
  const index = await router.resolve({
    SCRIPT_FILENAME: `${root}/`,
    SCRIPT_NAME: "/",
    DOCUMENT_ROOT: root,
  });
  assertEquals(index.scriptPath.endsWith("/index.php"), true);

  await Deno.remove(root, { recursive: true });
});
