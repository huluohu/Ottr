// 递归上传编排（2026-10-19 用户需求）：目录树遍历/远端建目录/逐文件入队。
import { describe, expect, it, vi } from "vitest";
import { uploadLocalTree, type UploadTreeDeps } from "./uploadTree";

function makeDeps(tree: Record<string, { name: string; is_dir: boolean }[]>): {
  deps: UploadTreeDeps;
  dirs: string[];
  files: Array<[string, string]>;
} {
  const dirs: string[] = [];
  const files: Array<[string, string]> = [];
  const deps: UploadTreeDeps = {
    list: async (abs) => {
      const keys = Object.keys(tree).filter((k) => k === abs || k.startsWith(abs + "/"));
      const direct = keys.filter((k) => k.replace(abs + "/", "").indexOf("/") === -1 && k !== abs);
      if (direct.length === 0 && !(abs in tree)) throw new Error(`no such dir: ${abs}`);
      return tree[abs] ?? direct.map((k) => ({ name: k.replace(abs + "/", ""), is_dir: true }));
    },
    mkdir: async (p) => {
      dirs.push(p);
    },
    uploadFile: async (local, remoteDir) => {
      files.push([local, remoteDir]);
    },
    joinLocal: (parent, name) => (parent === "/" ? `/${name}` : `${parent}/${name}`),
    joinRemote: (parent, name) => (parent === "/" ? `/${name}` : `${parent}/${name}`),
  };
  return { deps, dirs, files };
}

describe("uploadLocalTree", () => {
  it("单层目录：建远端目录 + 逐个上传（目标 = 该目录）", async () => {
    const { deps, dirs, files } = makeDeps({
      "/local/photos": [
        { name: "a.jpg", is_dir: false },
        { name: "b.jpg", is_dir: false },
      ],
    });
    const r = await uploadLocalTree("/local/photos", "/remote", deps);
    expect(r).toEqual({ dirs: 1, files: 2, skipped: 0, failed: 0 });
    expect(dirs).toEqual(["/remote/photos"]);
    expect(files).toEqual([
      ["/local/photos/a.jpg", "/remote/photos"],
      ["/local/photos/b.jpg", "/remote/photos"],
    ]);
  });

  it("嵌套子树：BFS 逐级建目录，文件落到各自父目录", async () => {
    const { deps, dirs, files } = makeDeps({
      "/l/d": [
        { name: "x.txt", is_dir: false },
        { name: "sub", is_dir: true },
      ],
      "/l/d/sub": [{ name: "y.txt", is_dir: false }],
    });
    const r = await uploadLocalTree("/l/d", "/r", deps);
    expect(r).toEqual({ dirs: 2, files: 2, skipped: 0, failed: 0 });
    expect(dirs).toEqual(["/r/d", "/r/d/sub"]);
    expect(files).toEqual([
      ["/l/d/x.txt", "/r/d"],
      ["/l/d/sub/y.txt", "/r/d/sub"],
    ]);
  });

  it("建目录失败：跳过整棵子树（不让每个文件各失败一次）", async () => {
    const { deps, files } = makeDeps({
      "/l/d": [{ name: "sub", is_dir: true }],
      "/l/d/sub": [{ name: "y.txt", is_dir: false }],
    });
    const failMkdir = vi.fn(async (p: string) => {
      if (p.endsWith("/sub")) throw new Error("mkdir denied");
    });
    const r = await uploadLocalTree("/l/d", "/r", { ...deps, mkdir: failMkdir });
    expect(r.skipped).toBe(1);
    expect(files).toEqual([]);
  });

  it("深度上限：超限目录计入 skipped（成环/异常树的兜底）", async () => {
    const { deps } = makeDeps({
      "/l/loop": [{ name: "self", is_dir: true }],
      "/l/loop/self": [{ name: "self", is_dir: true }],
      "/l/loop/self/self": [{ name: "self", is_dir: true }],
    });
    const r = await uploadLocalTree("/l/loop", "/r", deps, { maxDepth: 1, maxFiles: 100 });
    expect(r.skipped).toBeGreaterThan(0);
  });

  it("文件数上限：超出的文件不排队（计入 skipped）", async () => {
    const { deps, files } = makeDeps({
      "/l/d": [
        { name: "1.txt", is_dir: false },
        { name: "2.txt", is_dir: false },
        { name: "3.txt", is_dir: false },
      ],
    });
    const r = await uploadLocalTree("/l/d", "/r", deps, { maxDepth: 8, maxFiles: 2 });
    expect(r.files).toBe(2);
    expect(r.skipped).toBe(1);
    expect(files).toHaveLength(2);
  });

  it("单文件入队失败：计入 skipped 且**不中断整树**（后续文件照常入队）", async () => {
    // 2026-11-20 健壮性审计 P2：入队前失败（文件被删/不可读）此前会整体
    // 中断递归上传——头注释承诺的「失败不中断整树」在入队前这一段没兑现。
    const { deps, files } = makeDeps({
      "/l/d": [
        { name: "a.txt", is_dir: false },
        { name: "b.txt", is_dir: false },
        { name: "c.txt", is_dir: false },
      ],
    });
    const attempted: string[] = [];
    const r = await uploadLocalTree("/l/d", "/r", {
      ...deps,
      uploadFile: async (local, remoteDir) => {
        attempted.push(local);
        if (local.endsWith("b.txt")) throw new Error("file vanished before enqueue");
        files.push([local, remoteDir]);
      },
    });
    expect(r).toEqual({ dirs: 1, files: 2, skipped: 0, failed: 1 });
    expect(attempted).toEqual(["/l/d/a.txt", "/l/d/b.txt", "/l/d/c.txt"]); // c 仍被尝试
    expect(files).toEqual([
      ["/l/d/a.txt", "/r/d"],
      ["/l/d/c.txt", "/r/d"],
    ]);
  });
});
