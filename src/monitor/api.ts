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

/** 终止进程（force = SIGKILL，前端二次确认后才置位）；失败携带远端 stderr（EPERM 可见）。 */
export function killProcess(rustId: string, pid: number, force: boolean): Promise<void> {
  return invoke<void>("monitor_kill", { id: rustId, pid, force });
}
