// 进程浏览器数据面 API（Phase 3 Task 2，B4 下半）：invoke 契约层。
// Rust 命令（commands/monitor.rs）：monitor_ps / monitor_kill；
// 载荷与 ottr_monitor::ProcEntry serde 同构（snake_case 逐字对齐）。
import { invoke } from "@tauri-apps/api/core";

/** Rust `ottr_monitor::ProcEntry` 同构（单进程行）。 */
export interface ProcEntry {
  pid: number;
  ppid: number;
  user: string;
  cpu_percent: number;
  mem_percent: number;
  etime_secs: number;
  etime: string;
  comm: string;
}

/** 会话内只读采集进程列表（`ps -eo pid,ppid,user,pcpu,pmem,etime,comm --sort=-pcpu`）。 */
export function fetchProcesses(rustId: string): Promise<ProcEntry[]> {
  return invoke<ProcEntry[]>("monitor_ps", { id: rustId });
}

/** Rust `ottr_monitor::LogTailSample` 同构（日志关键字采样单轮，Phase 4 T2）。
 * data 只含完整行（Rust 侧按最后 `\n` 截断），data_bytes 是其精确字节长度
 * （游标推进面——字节账只在 Rust 算，TS 不自己数）。 */
export interface LogTailSample {
  /** 文件 inode（stat 失败/非 GNU stat = null：该轮静默跳过）。 */
  inode: number | null;
  /** stat 时刻文件大小（字节；截断判据）。 */
  size: number;
  /** 完整行前缀（lossy UTF-8；无完整行 = ""）。 */
  data: string;
  /** data 字节长度（残缺尾行不入账）。 */
  data_bytes: number;
}

/** 日志尾部采样（`monitor_log_tail`）：offset=null = 武装轮（只 stat 记
 * 水位，不回放历史）；数字 = 从该字节偏移续读。路径白名单校验在 Rust 入口。 */
export function fetchLogTail(
  rustId: string,
  path: string,
  offset: number | null,
): Promise<LogTailSample> {
  return invoke<LogTailSample>("monitor_log_tail", { id: rustId, path, offset });
}

/** 终止进程（force = SIGKILL，前端二次确认后才置位）；失败携带远端 stderr（EPERM 可见）。 */
export function killProcess(rustId: string, pid: number, force: boolean): Promise<void> {
  return invoke<void>("monitor_kill", { id: rustId, pid, force });
}
