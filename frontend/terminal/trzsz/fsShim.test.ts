// fsShim 单测（Phase 2 Task 4）：node callback 语义（errback 契约 / fd 偏移推进 /
// 首写截断后续追加 / access 模式 / errno 解析 / realpath）——走 node:fs 后端 +
// 真实临时目录，即 vitest 运行时下生产 invoke 后端的同语义替身（命令侧语义已由
// src-tauri trzsz_fs 单测独立钉住）。
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsShim, createPathShim, type FsBackend } from "./fsShim";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ottr-trzsz-fs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** callback → promise 包装（测试断言用）。 */
function call<T>(fn: (...args: unknown[]) => void, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    fn(...args, (err: (Error & { errno?: number }) | null, data?: T) => {
      if (err) reject(err);
      else resolve(data as T);
    });
  });
}

const decoder = new TextDecoder();

describe("fsShim（node callback 面语义）", () => {
  it("stat 报告缺失/文件/目录三元", async () => {
    const fs = createFsShim();
    await expect(call(fs.stat as never, join(dir, "nope"))).rejects.toMatchObject({ errno: -2 });
    await writeFile(join(dir, "f.txt"), "hello");
    const st = await call<{ isFile(): boolean; isDirectory(): boolean; size: number }>(
      fs.stat as never,
      join(dir, "f.txt"),
    );
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(st.size).toBe(5);
    const dt = await call<{ isDirectory(): boolean }>(fs.stat as never, dir);
    expect(dt.isDirectory()).toBe(true);
  });

  it("open+read 顺序读：position=null 偏移随读推进", async () => {
    const fs = createFsShim();
    await writeFile(join(dir, "bin"), "abcdefgh");
    const fd = await call<number>(fs.open as never, join(dir, "bin"), "r");
    const buf = new Uint8Array(3);
    const n1 = await call<number>(fs.read as never, fd, buf, 0, 3, null);
    expect(decoder.decode(buf.subarray(0, n1))).toBe("abc");
    const buf2 = new Uint8Array(3);
    const n2 = await call<number>(fs.read as never, fd, buf2, 0, 3, null);
    expect(decoder.decode(buf2.subarray(0, n2))).toBe("def");
    // 绝对位置读不动游标
    const buf3 = new Uint8Array(2);
    await call<number>(fs.read as never, fd, buf3, 0, 2, 0);
    expect(decoder.decode(buf3)).toBe("ab");
    const buf4 = new Uint8Array(3);
    const n4 = await call<number>(fs.read as never, fd, buf4, 0, 3, null);
    expect(decoder.decode(buf4.subarray(0, n4))).toBe("gh");
    await call(fs.close as never, fd);
  });

  it("open 不存在的文件报 ENOENT（errno -2）", async () => {
    const fs = createFsShim();
    await expect(call(fs.open as never, join(dir, "gone"), "r")).rejects.toMatchObject({ errno: -2 });
  });

  it("write：首写截断、后续追加（node open 'w' 语义）", async () => {
    const fs = createFsShim();
    await writeFile(join(dir, "out"), "abcdef");
    const fd = await call<number>(fs.open as never, join(dir, "out"), "w");
    const enc = new TextEncoder();
    await call<number>(fs.write as never, fd, enc.encode("xy"));
    await call<number>(fs.write as never, fd, enc.encode("zw"));
    await call(fs.close as never, fd);
    expect(await readFile(join(dir, "out"), "utf8")).toBe("xyzw");
  });

  it("access：存在/R_OK/W_OK 三态", async () => {
    const fs = createFsShim();
    await writeFile(join(dir, "f"), "x");
    const p = join(dir, "f");
    await expect(call(fs.access as never, p)).resolves.toBeUndefined();
    await expect(call(fs.access as never, p, 4)).resolves.toBeUndefined();
    await expect(call(fs.access as never, p, 2)).resolves.toBeUndefined();
    await expect(call(fs.access as never, join(dir, "gone"))).rejects.toMatchObject({ errno: -13 });
  });

  it("realpath 返回规范路径", async () => {
    const fs = createFsShim();
    const resolved = await call<string>(fs.realpath as never, dir);
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("readdir 列目录名", async () => {
    const fs = createFsShim();
    await writeFile(join(dir, "b.txt"), "");
    await writeFile(join(dir, "a.txt"), "");
    const names = await call<string[]>(fs.readdir as never, dir);
    expect(names.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("mkdir 递归建目录 + rm 递归删除", async () => {
    const fs = createFsShim();
    const nested = join(dir, "a/b/c");
    await expect(call(fs.mkdir as never, nested, { recursive: true, mode: 0o755 })).resolves.toBeUndefined();
    await writeFile(join(nested, "f"), "x");
    await expect(call(fs.rm as never, join(dir, "a"), { recursive: true })).resolves.toBeUndefined();
    await expect(call(fs.stat as never, nested)).rejects.toBeTruthy();
  });

  it("path 垫片：join/resolve/basename（POSIX + win 分隔符容忍）", () => {
    const path = createPathShim() as {
      join(...p: string[]): string;
      resolve(p: string): string;
      basename(p: string): string;
    };
    expect(path.join("/home/spike", "a.txt")).toBe("/home/spike/a.txt");
    expect(path.join("/tmp/", "/x", "y")).toBe("/tmp/x/y");
    expect(path.join("C:\\Users\\spike", "f.bin")).toBe("C:\\Users\\spike/f.bin");
    expect(path.resolve("/a/b")).toBe("/a/b");
    expect(path.resolve("rel")).toBe("/rel");
    expect(path.basename("/home/spike/a.txt")).toBe("a.txt");
    expect(path.basename("C:\\dir\\f.bin")).toBe("f.bin");
  });
});

describe("FsBackend 后端探测", () => {
  it("setFsBackendOverride 生效且可复位", async () => {
    const { getFsBackend, setFsBackendOverride } = await import("./fsShim");
    const fake: FsBackend = {
      stat: async (p) => ({ exists: p === "/fake", is_dir: false, is_file: true, size: 1, canonical: p }),
      readChunk: async () => new Uint8Array(0),
      writeChunk: async () => {},
      list: async () => [],
      mkdirp: async () => {},
      remove: async () => {},
      canRead: async () => true,
      canWrite: async () => true,
    };
    setFsBackendOverride(fake);
    const b = await getFsBackend();
    expect((await b.stat("/fake")).exists).toBe(true);
    expect((await b.stat("/other")).exists).toBe(false);
    setFsBackendOverride(null);
    const real = await getFsBackend();
    expect((await real.stat(dir)).is_dir).toBe(true); // node 运行时：真 fs 后端
  });
});
