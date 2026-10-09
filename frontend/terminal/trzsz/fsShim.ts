// trzsz fs 垫片（Phase 2 Task 4，B10 下半）：把 trzsz.js node 模式的 callback
// 风格 fs 调用映射到宿主 IO 后端。
//
// 选型背景（task-4 报告 §选型）：trzsz.js v1.1.6 的浏览器模式依赖 File System
// Access API（`showDirectoryPicker`，WKWebView 无），上传/下载在 Tauri webview
// 皆不可用；node 模式（Electron 同款路径）要求宿主提供 node callback fs——
// 本文件即该 fs 的最小实现，IO 落点二选一：
//   * node 运行时（vitest/端到端驱动）：动态 import("node:fs") 直读本地盘；
//   * Tauri webview（生产）：invoke trzsz_fs_* 命令（commands/trzsz_fs.rs）。
//
// 只实现 nodefs.ts 消费的面（getNewName/checkPath*：access/stat/mkdir/readdir/
// realpath/open/read/write/close/rm/rmdir/unlink + constants），fd 语义自管：
//   * read 的 position=null（NodefsFileReader 全部顺序读）→ fd 表跟踪偏移；
//   * write 无位置参数 → 首写 truncate（等价 open "w" 截断）、后续 append
//     （Rust 桥无状态，每次重开文件，O_APPEND 语义在命令侧）；
//   * 错误对象带 errno（从 Rust "os error N" 文本解析，doCreateFile 消费）。
//
// 路径垫片只实现 nodefs 用到的 join/resolve/basename（POSIX 为主、容忍 win 分隔
// 符——Tauri 对话框给的本地路径两种形态都有；std::fs 与 node:fs 都吃混合分隔符）。
// 测试后端注入：setFsBackendOverride（TrzszController.test/fUTURE 契约测试用）。

/** stat 结果（Rust TrzszFsStat 同构 / node Stats 投影）。 */
export interface TrzszFsStat {
  exists: boolean;
  is_dir: boolean;
  is_file: boolean;
  size: number;
  canonical: string;
}

/** 宿主 IO 后端（promise 面；两实现：tauri invoke / node:fs）。 */
export interface FsBackend {
  stat(path: string): Promise<TrzszFsStat>;
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
  writeChunk(path: string, data: Uint8Array, truncate: boolean): Promise<void>;
  list(path: string): Promise<string[]>;
  mkdirp(path: string): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
  canRead(path: string): Promise<boolean>;
  canWrite(path: string): Promise<boolean>;
}

// --- base64（invoke 面载荷；块级小缓冲，手工转换免引依赖） --------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- Tauri invoke 后端（生产；命令域 desktop/src/commands/trzsz_fs.rs） -----

function tauriFsBackend(): FsBackend {
  // 延迟 import：避免无 Tauri 环境在模块加载期即触发 @tauri-apps/api 副作用
  return {
    stat: (path) => invokeStat(path),
    readChunk: async (path, offset, length) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return base64ToBytes(await invoke("trzsz_fs_read", { path, offset, len: length }));
    },
    writeChunk: async (path, data, truncate) => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("trzsz_fs_write", { path, data: bytesToBase64(data), truncate });
    },
    list: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke("trzsz_fs_list", { path });
    },
    mkdirp: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("trzsz_fs_mkdir", { path });
    },
    remove: async (path, recursive) => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("trzsz_fs_remove", { path, recursive });
    },
    canRead: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke("trzsz_fs_check", { path, mode: "read" });
    },
    canWrite: async (path) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke("trzsz_fs_check", { path, mode: "write" });
    },
  };
}

async function invokeStat(path: string): Promise<TrzszFsStat> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("trzsz_fs_stat", { path });
}

// --- node:fs 后端（vitest / 端到端驱动；生产 webview 无 process 走不到） -------
// 结构面最小类型（项目不含 @types/node；动态 import 以 unknown 接入后按此收窄）。

interface NodeFileHandleLike {
  read(buf: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

interface NodeFsPromisesLike {
  stat(p: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>;
  open(p: string, flags: string): Promise<NodeFileHandleLike>;
  writeFile(p: string, data: Uint8Array, opts?: { flag?: string }): Promise<void>;
  readdir(p: string): Promise<unknown[]>;
  mkdir(p: string, opts: { recursive: boolean }): Promise<unknown>;
  rm(p: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
  access(p: string, mode?: number): Promise<void>;
  realpath(p: string): Promise<string>;
}

interface NodeFsConstantsLike {
  constants: { R_OK: number; W_OK: number };
}

function nodeFsBackend(fsp: NodeFsPromisesLike, fsc: NodeFsConstantsLike): FsBackend {
  return {
    stat: async (path) => {
      try {
        const st = await fsp.stat(path);
        return {
          exists: true,
          is_dir: st.isDirectory(),
          is_file: st.isFile(),
          size: st.size,
          canonical: await fsp.realpath(path).catch(() => path),
        };
      } catch {
        return { exists: false, is_dir: false, is_file: false, size: 0, canonical: path };
      }
    },
    readChunk: async (path, offset, length) => {
      const fh = await fsp.open(path, "r");
      try {
        const buf = new Uint8Array(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
    writeChunk: (path, data, truncate) =>
      fsp.writeFile(path, data, truncate ? {} : { flag: "a" }),
    list: (path) => fsp.readdir(path) as unknown as Promise<string[]>,
    mkdirp: (path) => fsp.mkdir(path, { recursive: true }) as unknown as Promise<void>,
    remove: (path, recursive) => fsp.rm(path, { recursive, force: false }) as unknown as Promise<void>,
    canRead: (path) => fsp.access(path, fsc.constants.R_OK).then(() => true, () => false),
    canWrite: (path) => fsp.access(path, fsc.constants.W_OK).then(() => true, () => false),
  };
}

// --- 后端解析（memoized；node 运行时优先，webview 走 invoke） -----------------

let backendPromise: Promise<FsBackend> | null = null;
let backendOverride: FsBackend | null = null;

/** 测试注入点（置 null 恢复自动探测）。 */
export function setFsBackendOverride(b: FsBackend | null): void {
  backendOverride = b;
  backendPromise = null;
}

function detectBackend(): Promise<FsBackend> {
  if (backendOverride) return Promise.resolve(backendOverride);
  // 不引 @types/node：process 以结构面从 globalThis 取（webview 无 → invoke 后端）
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc?.versions?.node) {
    // 变量拼接 specifier + @vite-ignore：生产浏览器构建不打包 node 内置模块
    // （webview 无 process.versions.node，走不到此分支）。
    return (async () => {
      try {
        const fsp = (await import(/* @vite-ignore */ ("node:" + "fs/promises"))) as unknown as NodeFsPromisesLike;
        const fs = (await import(/* @vite-ignore */ ("node:" + "fs"))) as unknown as NodeFsConstantsLike;
        return nodeFsBackend(fsp, fs);
      } catch {
        return tauriFsBackend();
      }
    })();
  }
  return Promise.resolve(tauriFsBackend());
}

export function getFsBackend(): Promise<FsBackend> {
  if (!backendPromise) backendPromise = detectBackend();
  return backendPromise;
}

// --- 错误对象（errno 供 nodefs doCreateFile 的 -13/-21 分支） ------------------

function fsError(message: string): Error & { errno?: number } {
  const err = new Error(message) as Error & { errno?: number };
  const m = /os error (\d+)/.exec(message);
  if (m) err.errno = -Number(m[1]); // node 惯例：负 errno（EACCES=13 → -13）
  return err;
}

// --- fs 垫片（callback 风格，nodefs.ts 消费面） --------------------------------

interface FdRecord {
  path: string;
  readPos: number;
  truncatePending: boolean;
}

/** 创建 fs 垫片（nodefs 顶层 `requireSafely("fs")` 拿到的对象）。 */
export function createFsShim(): Record<string, unknown> {
  const fdTable = new Map<number, FdRecord>();
  let nextFd = 1;

  const backendStat = (path: string, cb: (err: unknown, stats?: unknown) => void) => {
    void getFsBackend()
      .then((b) => b.stat(path))
      .then((st) => {
        if (!st.exists) {
          cb(fsError(`ENOENT: no such file or directory, stat '${path}' (os error 2)`));
          return;
        }
        cb(null, {
          isDirectory: () => st.is_dir,
          isFile: () => st.is_file,
          isSymbolicLink: () => false,
          size: st.size,
        });
      })
      .catch((e) => cb(fsError(String(e))));
  };

  return {
    constants: { R_OK: 4, W_OK: 2, F_OK: 0 },

    access(path: string, ...rest: unknown[]) {
      const cb = rest.pop() as (err: Error | null) => void;
      const mode = rest[0] as number | undefined;
      void getFsBackend()
        .then(async (b) => {
          const st = await b.stat(path);
          if (!st.exists) return false;
          if (mode === 4) return b.canRead(path);
          if (mode === 2) return b.canWrite(path);
          return true;
        })
        .then((ok) => cb(ok ? null : fsError(`EACCES: permission denied, access '${path}' (os error 13)`)))
        .catch(() => cb(fsError(`ENOENT: no such file or directory, access '${path}' (os error 2)`)));
    },

    stat: backendStat,

    realpath(path: string, cb: (err: unknown, resolved?: string) => void) {
      void getFsBackend()
        .then((b) => b.stat(path))
        .then((st) => {
          if (!st.exists) throw fsError(`ENOENT: no such file or directory, realpath '${path}' (os error 2)`);
          cb(null, st.canonical);
        })
        .catch((e) => cb(e));
    },

    open(path: string, flags: string, cb: (err: unknown, fd?: number) => void) {
      void getFsBackend()
        .then((b) => b.stat(path))
        .then((st) => {
          // "r"：文件必须存在（node 语义）；"w"：只记 fd，截断延到首写
          if (flags.includes("r") && !st.exists) {
            throw fsError(`ENOENT: no such file or directory, open '${path}' (os error 2)`);
          }
          if (flags.includes("r") && st.is_dir) {
            throw fsError(`EISDIR: illegal operation on a directory, read '${path}' (os error 21)`);
          }
          if (flags.includes("w") && st.is_dir) {
            throw fsError(`EISDIR: illegal operation on a directory, open '${path}' (os error 21)`);
          }
          const fd = nextFd++;
          fdTable.set(fd, { path, readPos: 0, truncatePending: flags.includes("w") });
          cb(null, fd);
        })
        .catch((e) => cb(e));
    },

    read(
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
      cb: (err: unknown, bytesRead?: number, buf?: Uint8Array) => void,
    ) {
      const rec = fdTable.get(fd);
      if (!rec) {
        cb(fsError(`EBADF: bad file descriptor, read (os error 9)`));
        return;
      }
      const absPos = position ?? rec.readPos;
      void getFsBackend()
        .then((b) => b.readChunk(rec.path, absPos, length))
        .then((bytes) => {
          if (bytes.length > 0) buffer.set(bytes, offset);
          if (position === null) rec.readPos = absPos + bytes.length;
          cb(null, bytes.length, buffer);
        })
        .catch((e) => cb(e));
    },

    write(fd: number, ...rest: unknown[]) {
      const cb = rest.pop() as (err: unknown, written?: number) => void;
      const data = rest[0] as Uint8Array;
      const rec = fdTable.get(fd);
      if (!rec) {
        cb(fsError(`EBADF: bad file descriptor, write (os error 9)`));
        return;
      }
      const truncate = rec.truncatePending;
      rec.truncatePending = false;
      void getFsBackend()
        .then((b) => b.writeChunk(rec.path, data, truncate))
        .then(() => cb(null, data.length))
        .catch((e) => cb(e));
    },

    close(fd: number, cb: (err: unknown) => void) {
      fdTable.delete(fd);
      cb(null);
    },

    readdir(path: string, cb: (err: unknown, names?: string[]) => void) {
      void getFsBackend()
        .then((b) => b.list(path))
        .then((names) => cb(null, names))
        .catch((e) => cb(fsError(String(e))));
    },

    mkdir(path: string, ...rest: unknown[]) {
      const cb = rest.pop() as (err: unknown) => void;
      void getFsBackend()
        .then((b) => b.mkdirp(path))
        .then(() => cb(null))
        .catch((e) => cb(fsError(String(e))));
    },

    rm(path: string, ...rest: unknown[]) {
      const cb = rest.pop() as (err: unknown) => void;
      const opts = (rest[0] as { recursive?: boolean } | undefined) ?? {};
      void getFsBackend()
        .then((b) => b.remove(path, opts.recursive === true))
        .then(() => cb(null))
        .catch((e) => cb(fsError(String(e))));
    },

    rmdir(path: string, ...rest: unknown[]) {
      const cb = rest.pop() as (err: unknown) => void;
      const opts = (rest[0] as { recursive?: boolean } | undefined) ?? {};
      void getFsBackend()
        .then((b) => b.remove(path, opts.recursive === true))
        .then(() => cb(null))
        .catch((e) => cb(fsError(String(e))));
    },

    unlink(path: string, cb: (err: unknown) => void) {
      void getFsBackend()
        .then((b) => b.remove(path, false))
        .then(() => cb(null))
        .catch((e) => cb(fsError(String(e))));
    },
  };
}

// --- path 垫片（nodefs 消费面：join/resolve/basename） -------------------------

function normalizePath(p: string): string {
  // 折叠重复分隔符（保留前导）；不解析 ".."（nodefs 只做拼接，传给底层 fs）
  return p.replace(/([\\/])\1+/g, "$1");
}

/** node:path 最小面（POSIX 为主，容忍 win 分隔符——两种对话框路径形态都合法）。 */
export function createPathShim(): Record<string, unknown> {
  return {
    sep: "/",
    join(...parts: string[]): string {
      let out = "";
      for (const part of parts) {
        if (!part) continue;
        out = out ? `${out.replace(/[\\/]+$/, "")}/${part.replace(/^[\\/]+/, "")}` : part;
      }
      return normalizePath(out);
    },
    resolve(p: string): string {
      // 对话框/夹具路径均为绝对；相对路径按 POSIX 根处理（MVP，报告记录）
      if (/^([A-Za-z]:[\\/])/.test(p) || p.startsWith("/")) return normalizePath(p);
      return normalizePath(`/${p}`);
    },
    basename(p: string): string {
      const segs = p.split(/[\\/]/).filter(Boolean);
      return segs.length ? segs[segs.length - 1] : p;
    },
  };
}
