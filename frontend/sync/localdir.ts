// 本地目录同步通道（Phase 5 Task 2）——用户授权目录内的信封文件读写。
//
// 授权沿 trzsz grants 先例（Phase 2 Task 4 / Fix round 1 I-1 的会话级白名单）：
//   * 授权入口只有用户动作——Task 4 设置页经系统对话框（plugin-dialog）选目录
//     后调 deps.grant 登记；生产实现 = invoke("trzsz_grant", { scope: "sync",
//     paths: [dir], kind: "dir" })，IO 落在既有 trzsz_fs_* 命令——白名单校验、
//     canonical 化、`..`/symlink 逃逸防护全部复用 Rust 侧权威面（零新命令）；
//   * 传输层自身只做一条前置防线：fileName 必须是裸文件名（拒 / \\ ..），
//     防配置错误把信封指到授权目录外（权威校验仍在 Rust 白名单）。
//
// 语义面：fetch = stat 404 → null；push = truncate 覆盖（last-writer-wins，
// 本机/移动盘通道的并发面本就单写者，契约文件头有声明）；test = 目录存在 +
// 真实可写探针（trzsz_fs_check(mode=write) 的探针语义经 FsBackend.canWrite）。
import { parseEnvelopeJson, type SyncTransport } from "./transport";
import type { SyncEnvelope } from "./envelope";

/** 目录 IO 最小面（fsShim FsBackend 的结构子集——生产直接复用其实例）。 */
export interface SyncDirFs {
  stat(path: string): Promise<{ exists: boolean; is_dir: boolean; is_file: boolean; size: number }>;
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
  writeChunk(path: string, data: Uint8Array, truncate: boolean): Promise<void>;
  /** 真实可写判定（探针语义，非位掩码）。 */
  canWrite(path: string): Promise<boolean>;
}

export interface LocalDirConfig {
  /** 授权目录（Task 4 对话框选定；函数形态支持每次同步重取）。 */
  dir: string | (() => Promise<string>);
  /** 信封文件名（必须裸名；缺省 ottr-sync.json）。 */
  fileName?: string;
}

export interface LocalDirDeps {
  fs: SyncDirFs;
  /** 授权登记（生产 = trzsz_grant scope "sync"；测试 = 白名单假件）。 */
  grant?: (dir: string, kind: "dir") => Promise<void>;
}

const DEFAULT_FILE_NAME = "ottr-sync.json";

/** 裸文件名校验（防路径注入；权威白名单在 Rust grants 面）。 */
export function assertBareFileName(name: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`localdir: fileName must be a bare name, got ${JSON.stringify(name)}`);
  }
}

/** 生产接线：fsShim 后端（webview=trzsz_fs_* invoke，node=直读盘）+ trzsz_grant。 */
export function tauriLocalDirDeps(): LocalDirDeps {
  return {
    grant: async (dir) => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("trzsz_grant", { scope: "sync", paths: [dir], kind: "dir" });
    },
    fs: {
      stat: async (path) => {
        const { getFsBackend } = await import("../terminal/trzsz/fsShim");
        return getFsBackend().then((b) => b.stat(path));
      },
      readChunk: async (path, offset, length) => {
        const { getFsBackend } = await import("../terminal/trzsz/fsShim");
        return getFsBackend().then((b) => b.readChunk(path, offset, length));
      },
      writeChunk: async (path, data, truncate) => {
        const { getFsBackend } = await import("../terminal/trzsz/fsShim");
        return getFsBackend().then((b) => b.writeChunk(path, data, truncate));
      },
      canWrite: async (path) => {
        const { getFsBackend } = await import("../terminal/trzsz/fsShim");
        return getFsBackend().then((b) => b.canWrite(path));
      },
    },
  };
}

export function createLocalDirTransport(config: LocalDirConfig, deps: LocalDirDeps): SyncTransport {
  const fileName = config.fileName ?? DEFAULT_FILE_NAME;
  assertBareFileName(fileName);

  const resolveDir = async (): Promise<string> => {
    const dir = typeof config.dir === "function" ? await config.dir() : config.dir;
    const trimmed = dir.trim();
    if (trimmed === "") throw new Error("localdir: sync directory is not configured");
    return trimmed;
  };

  /** 授权 + 组装文件路径（每操作重走：授权是登记面，幂等且目录可换）。 */
  async function grantAndResolve(): Promise<{ dir: string; file: string }> {
    const dir = await resolveDir();
    await deps.grant?.(dir, "dir");
    // POSIX join（std::fs 与 node:fs 均容忍混合分隔符；Windows 盘符目录同样可用）
    return { dir, file: `${dir.replace(/\/+$/, "")}/${fileName}` };
  }

  return {
    kind: "localdir",

    async fetch(): Promise<SyncEnvelope | null> {
      const { file } = await grantAndResolve();
      const st = await deps.fs.stat(file);
      if (!st.exists) return null;
      const bytes = await deps.fs.readChunk(file, 0, st.size);
      return parseEnvelopeJson(new TextDecoder().decode(bytes));
    },

    async push(envelope: SyncEnvelope): Promise<void> {
      const { file } = await grantAndResolve();
      await deps.fs.writeChunk(file, new TextEncoder().encode(JSON.stringify(envelope)), true);
    },

    async test(): Promise<boolean> {
      try {
        const { dir } = await grantAndResolve();
        const st = await deps.fs.stat(dir);
        return st.exists && st.is_dir && (await deps.fs.canWrite(dir));
      } catch {
        return false;
      }
    },
  };
}
