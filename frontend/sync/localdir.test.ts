// 本地目录通道测试（Phase 5 Task 2）——temp dir 真盘 roundtrip（node:fs 后端
// + trzsz grants 同款白名单假件）：授权内通过、目录外拒绝、裸文件名防线、
// test 探针布尔面。端到端跑在 node 环境（fsShim 同款双后端纪律）。
// @vitest-environment node
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sealEnvelope } from "./envelope";
import { assertBareFileName, createLocalDirTransport, type LocalDirDeps, type SyncDirFs } from "./localdir";

/**
 * trzsz grants 同款白名单假件（镜像 commands/trzsz_fs.rs 语义）：
 * 登记 Dir 授权（resolve 吃 `..`）→ 读写路径必须落在授权内（组件级前缀）。
 * 生产权威面在 Rust trzsz_grant/trzsz_fs_*——本假件只演示传输层的授权挂钩。
 */
function grantedFs(root: string): SyncDirFs {
  const inside = (p: string): boolean => {
    const r = resolve(root);
    const t = resolve(p);
    return t === r || t.startsWith(r + "/") || t.startsWith(r + "\\");
  };
  const ensure = (p: string): void => {
    if (!inside(p)) throw new Error(`path not granted for sync transfer: ${p}`);
  };
  return {
    stat: async (path) => {
      ensure(path); // trzsz 面七命令全过白名单——stat 同样守卫
      try {
        const st = await stat(path);
        return { exists: true, is_dir: st.isDirectory(), is_file: st.isFile(), size: st.size };
      } catch {
        return { exists: false, is_dir: false, is_file: false, size: 0 };
      }
    },
    readChunk: async (path, offset, length) => {
      ensure(path);
      const buf = new Uint8Array(length);
      const f = await import("node:fs/promises");
      const fh = await f.open(path, "r");
      try {
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
    writeChunk: async (path, data, truncate) => {
      ensure(path);
      const f = await import("node:fs/promises");
      await f.writeFile(path, data, truncate ? {} : { flag: "a" });
    },
    canWrite: async (path) => {
      ensure(path);
      try {
        const probe = join(path, `.ottr-wprobe-${Date.now()}`);
        await writeFile(probe, "");
        await (await import("node:fs/promises")).rm(probe);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function depsFor(root: string, grantedDirs: string[]): Promise<LocalDirDeps> {
  return {
    // 授权登记假件（生产 = trzsz_grant invoke；这里只记录登记动作）
    grant: async (dir, kind) => {
      expect(kind).toBe("dir");
      grantedDirs.push(dir);
    },
    fs: grantedFs(root),
  };
}

describe("本地目录通道（temp dir 真盘）", () => {
  it("roundtrip：push → fetch → 信封相等 + 落盘文件确为信封 JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "ottr-sync-dir-"));
    const granted: string[] = [];
    const t = createLocalDirTransport({ dir: root }, await depsFor(root, granted));

    // 首次：无文件 → null（file 尚未存在）
    expect(await t.fetch()).toBeNull();

    const sealed = await sealEnvelope('{"groups":[1,2]}', "dir-pass");
    await t.push(sealed);
    expect(await t.fetch()).toEqual(sealed);
    expect(granted).toEqual([root, root, root]); // 每操作重走授权登记（幂等）

    // 落盘字节 = 信封 JSON（可从盘上独立验证——通道只是搬运）
    const onDisk = JSON.parse(await readFile(join(root, "ottr-sync.json"), "utf8"));
    expect(onDisk).toEqual(sealed);
  });

  it("test：目录存在+可写=true；目录不存在=false；文件形态=false", async () => {
    const root = await mkdtemp(join(tmpdir(), "ottr-sync-dir-"));
    const granted: string[] = [];
    expect(await createLocalDirTransport({ dir: root }, await depsFor(root, granted)).test()).toBe(true);

    const missing = join(root, "no-such-dir");
    expect(await createLocalDirTransport({ dir: missing }, await depsFor(root, granted)).test()).toBe(false);

    const filePath = join(root, "afile");
    await writeFile(filePath, "x");
    expect(await createLocalDirTransport({ dir: filePath }, await depsFor(root, granted)).test()).toBe(false);
  });

  it("白名单外路径拒绝（授权目录的兄弟目录/上级路径不可写）", async () => {
    const root = await mkdtemp(join(tmpdir(), "ottr-sync-dir-"));
    const evil = await mkdtemp(join(tmpdir(), "ottr-sync-evil-"));
    const granted: string[] = [];
    const deps = await depsFor(root, granted);
    // 传输层配置指向授权外的目录：grant 假件登记了，但 fs 白名单拒 IO
    const t = createLocalDirTransport({ dir: evil }, deps);
    const sealed = await sealEnvelope("x", "pw");
    await expect(t.push(sealed)).rejects.toThrow("not granted");
    await expect(t.fetch()).rejects.toThrow("not granted");
  });

  it("裸文件名防线：路径分隔符/.. 拒绝于构造时；自定义文件名 roundtrip", async () => {
    expect(() => assertBareFileName("sub/dir.json")).toThrow("bare name");
    expect(() => assertBareFileName("..")).toThrow("bare name");
    expect(() => assertBareFileName("back\\slash.json")).toThrow("bare name");
    expect(() => assertBareFileName("")).toThrow("bare name");
    for (const ok of ["ottr-sync.json", "同步信封.json", ".hidden"]) {
      expect(() => assertBareFileName(ok)).not.toThrow();
    }

    const root = await mkdtemp(join(tmpdir(), "ottr-sync-dir-"));
    const t = createLocalDirTransport({ dir: root, fileName: "同步信封.json" }, await depsFor(root, []));
    const sealed = await sealEnvelope("named", "pw");
    await t.push(sealed);
    expect(await t.fetch()).toEqual(sealed);
    // 路径注入形态在构造时即拒（不发任何 IO）
    const escapeDeps = await depsFor(root, []);
    expect(() => createLocalDirTransport({ dir: root, fileName: "../escape.json" }, escapeDeps)).toThrow("bare name");
  });
});
