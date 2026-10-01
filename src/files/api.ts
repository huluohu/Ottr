// Task 10（A5）文件面板命令面封装：Rust 命令名契约与载荷类型同构。
// Rust 侧定义见 src-tauri/src/lib.rs「Task 10」节；ottr_transfer::DirEntry 直出。
import { invoke } from "@tauri-apps/api/core";

/** 远端目录项（Rust ottr_transfer::DirEntry 同构）。mode 为 POSIX 权限位。 */
export interface DirEntry {
  name: string;
  is_dir: boolean;
  size: number;
  mode: number;
  /** 秒级 Unix 时间。 */
  mtime: number;
}

/** 本地目录项（Rust LocalEntry 同构）。 */
export interface LocalEntry {
  name: string;
  is_dir: boolean;
  size: number;
  mode: number;
  mtime: number;
}

/** 传输启动回执（Rust TransferStarted 同构）。 */
export interface TransferStarted {
  transfer_id: string;
  local_path: string;
  remote_path: string;
  total: number;
}

export function sftpList(id: string, path: string): Promise<DirEntry[]> {
  return invoke("sftp_list", { id, path });
}

export function sftpRealpath(id: string, path: string): Promise<string> {
  return invoke("sftp_realpath", { id, path });
}

export function sftpMkdir(id: string, path: string): Promise<void> {
  return invoke("sftp_mkdir", { id, path });
}

export function sftpRename(id: string, from: string, to: string): Promise<void> {
  return invoke("sftp_rename", { id, from, to });
}

export function sftpRemove(id: string, path: string, isDir: boolean): Promise<void> {
  return invoke("sftp_remove", { id, path, isDir });
}

/** mode 传完整权限位的十进制值（0o644 = 420）。 */
export function sftpChmod(id: string, path: string, mode: number): Promise<void> {
  return invoke("sftp_chmod", { id, path, mode });
}

export function localList(path: string): Promise<LocalEntry[]> {
  return invoke("local_list", { path });
}

export function localHome(): Promise<string> {
  return invoke("local_home");
}

export function localDownloadsDir(): Promise<string> {
  return invoke("local_downloads_dir");
}

/** local 缺省 → Rust 侧落「下载目录/远端文件名」（MVP 降级裁定）。 */
export function sftpDownload(id: string, remote: string, local?: string): Promise<TransferStarted> {
  return invoke("sftp_download", { id, remote, local: local ?? null });
}

export function sftpUpload(id: string, local: string, remoteDir: string): Promise<TransferStarted> {
  return invoke("sftp_upload", { id, local, remoteDir });
}

export function transferCancel(transferId: string): Promise<void> {
  return invoke("transfer_cancel", { transferId });
}

// --- 纯函数（可测面） ---------------------------------------------------------

/** 路径取文件名（两端通用；末尾 `/` 容忍）。 */
export function fileNameOf(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** 路径取父目录（含根保护："/a" → "/"）。 */
export function parentOf(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

/** 路径拼接（远端 posix；base 以 / 结尾或根时安全）。 */
export function joinRemote(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}

/** 字节人性化（1024 进制；B/KB/MB/GB/TB）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : 1;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** 权限位 → "rwxr-xr-x" 形态（仅低 9 位；类型位不展示）。 */
export function formatMode(mode: number): string {
  const bit = (n: number, c: string) => (n ? c : "-");
  const rwx = (m: number) => bit(m & 4, "r") + bit(m & 2, "w") + bit(m & 1, "x");
  return `${rwx((mode >> 6) & 7)}${rwx((mode >> 3) & 7)}${rwx(mode & 7)}`;
}
