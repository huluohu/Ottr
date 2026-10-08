// 终端 sink 注册表与会话收尾钩子（自 SessionStore.ts 拆出）：非响应式的
// 模块级注册表（Terminal 挂载注册写入口）+ resize 下发去重 + AI 纪要钩子。
// 对 useSessionStore 的引用全部发生在函数体内（运行期取用），ESM 循环导入安全。
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "./types";
import { useSessionStore } from "./SessionStore";

/** Rust Raw 帧应为 ArrayBuffer（Phase 0 定案）；string 仅 base64 fallback 时出现。 */
export function toBytes(m: unknown): Uint8Array {
  if (m instanceof ArrayBuffer) return new Uint8Array(m);
  if (m instanceof Uint8Array) return m;
  if (typeof m === "string") {
    const bin = atob(m);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error(`unexpected channel message type: ${typeof m}`);
}

// --- 终端 sink 与计时器（非响应式，模块级注册表） ----------------------------

/** 每会话的终端写入口 + 尺寸（SessionTerminal 挂载时注册）。 */
export interface TerminalSink {
  write: (bytes: Uint8Array) => void;
  /** 当前 cols/rows（attach 时取；未挂载回落 80x24）。 */
  getSize: () => { cols: number; rows: number };
}

export const sinks = new Map<string, TerminalSink>();
/** 每会话最近一次下发的 PTY 尺寸（缺陷 34：同尺寸不去重会多打无谓重绘）。
 * 键 = 前端会话 id，值绑定 rustId——重连换新 PTY（新进程按 attach 尺寸重建，
 * 可能又是 2×1/80×24）时必须重发，绝不能按「会话 id + 尺寸」跨连接去重。 */
const lastResize = new Map<string, { rustId: string; size: string }>();
export function registerSink(sessionId: string, sink: TerminalSink): void {
  sinks.set(sessionId, sink);
}
export function unregisterSink(sessionId: string): void {
  sinks.delete(sessionId);
  lastResize.delete(sessionId);
}

/** PTY 尺寸变更（缺陷 34）：fit 后把真实 cols/rows 投给 Rust
 * `resize_session`（挂起槽 → 转发循环 window_change）。守卫：会话在册且
 * rustId 已落地（connecting 期调用落空——fit 是视觉层语义，不打扰）；
 * 同一 rustId 上同尺寸去重（每次布局触发的 fit 不重复下发），rustId 变化
 * （重连 = 新 PTY 进程）必然重发。fire-and-forget：失败静默（会话可能刚断开）。 */
export function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): void {
  const session = useSessionStore
    .getState()
    .sessions.find((x) => x.id === sessionId);
  if (!session?.rustId || cols <= 0 || rows <= 0) return;
  const size = `${cols}x${rows}`;
  const last = lastResize.get(sessionId);
  if (last && last.rustId === session.rustId && last.size === size) return;
  lastResize.set(sessionId, { rustId: session.rustId, size });
  void invoke("resize_session", { id: session.rustId, cols, rows }).catch(
    () => {},
  );
}

/** host key 拒绝的可识别错误串（Rust Error::HostKeyRejected Display 前缀）。 */
export function isHostKeyRejection(err: string): boolean {
  return err.includes("host key rejected");
}

// --- 会话结束钩子（Phase 2 Task 7 会话纪要）----------------------------------
// 「会话收尾」三时机（closeTab / disconnect / 自动重连耗尽转 disconnected）向
// App 注入的钩子派发一次（消费方 = src/ai/summary.ts onSessionEnded，异步生成
// 会话纪要）。store 保持纯状态机、不反向依赖 AI 链路（setAiSettingsOpener 同
// 惯例）；钩子异常绝不反噬状态机（closeTab/disconnect 是用户交互主路径）。

/** 会话收尾信息（钩子入参；纪要生成链只需要归属三元组）。 */
export interface SessionEndInfo {
  hostId: number;
  /** 前端会话 id（标签 uuid，跨重连稳定——history.session_id 同源）。 */
  id: string;
  hostName: string;
}

let sessionEndHook: ((info: SessionEndInfo) => void) | null = null;

/** 注入/摘除会话结束钩子（App 挂载时接 onSessionEnded；null = 摘除）。 */
export function setSessionEndHook(fn: ((info: SessionEndInfo) => void) | null): void {
  sessionEndHook = fn;
}

/** 会话收尾派发（同步返回；钩子自身负责 fire-and-forget 与静默）。 */
export function emitSessionEnded(session: Session): void {
  const hook = sessionEndHook;
  if (!hook) return;
  try {
    hook({ hostId: session.hostId, id: session.id, hostName: session.hostName });
  } catch (e) {
    console.warn("[session] end hook failed:", e);
  }
}
