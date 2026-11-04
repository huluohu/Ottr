// AI 终端目标（Ask Ottr，Task 2）：把「AI 在跟哪个终端说话」钉成不可变快照，
// 杜绝按主机名/最近活动标签路由。三个纯函数构成目标生命周期：
//   resolveFocusedTerminal —— 从状态切片解析「当前聚焦 pane」的可用终端会话
//                             （无活动标签/聚焦失效/未连接/纯文件会话 → null，
//                             **绝不回退**到根标签或最近活动标签）；
//   captureAiTarget        —— 把可用会话定格为 AiScopeTarget（含连接代数）；
//   isAiTargetLive         —— 目标复用前五元全等校验（pane/kind/host/rustId/
//                             epoch 任一失配即死，重连/shell_exit/关闭全覆盖）。
// 类型在本模块本地定义（与 ai/sessionApi.ts 的 AiScopeTarget 结构兼容但不互相
// 导入——依赖方向：ai 消费 session，session 域不认识 ai 域）。
import type { Session } from "./types";

export type AiTargetKind = "ssh" | "local";

/** 不可变目标快照（发给 Rust ai_scope_open 的定位五元 + 归属）。 */
export interface AiScopeTarget {
  /** 聚焦 pane 的会话 id（分屏时 = 叶子 id，非标签根）。 */
  paneSessionId: string;
  /** 所属标签根会话 id（paneOf ?? id）——UI「回到原标签」用。 */
  rootTabId: string;
  /** 捕获时的 Rust 会话 id（重连即换新 → 旧目标必死）。 */
  rustId: string;
  /** 捕获时的连接代数（attach 成功 +1、shell_exit +1；见 Session 字段注释）。 */
  connectionEpoch: number;
  kind: AiTargetKind;
  /** 目标主机 id；本地终端 = null（hostId=-1 是前端哨兵，不出本模块）。 */
  hostId: number | null;
}

/** resolveFocusedTerminal / isAiTargetLive 的入参面（结构兼容 useSessionStore
 * 的状态切片；不 import store——纯函数不拖状态机依赖图，测试直构状态）。 */
export interface AiFocusState {
  activeId: string | null;
  activePane: Record<string, string>;
  sessions: Session[];
}

/** 连接代数取值（缺省 0 = 存量夹具/旧构造点兼容）。唯一读取口径。 */
export function currentEpoch(session: { connectionEpoch?: number }): number {
  return session.connectionEpoch ?? 0;
}

/** 会话是否带 PTY 终端：ftp/ftps 是纯文件会话（无终端），永不作 AI 目标。 */
export function isTerminalSession(session: Session): boolean {
  if (session.kind === "local") return true;
  return session.protocol !== "ftp" && session.protocol !== "ftps";
}

/** 目标 kind（kind 字段可选的存量口径：缺省 ssh）。 */
export function targetKind(session: Session): AiTargetKind {
  return session.kind ?? "ssh";
}

/** 目标归属主机（本地终端 → null，不携带 -1 哨兵）。 */
export function targetHostId(session: Session): number | null {
  return targetKind(session) === "local" ? null : session.hostId;
}

/** 解析当前聚焦 pane 的可用终端会话。
 *
 * 聚焦 pane = activePane[activeId] ?? activeId（仅 activeId 非空时）；解析
 * 不到（无活动标签 / 聚焦指向已移除的 pane）/ 不可用（未连接、无 rustId、
 * ftp/ftps）一律 null——**无任何回退**：聚焦失效 ≠ 允许漂到根标签或最近
 * 活动标签（AI 插错终端比不插更危险）。 */
export function resolveFocusedTerminal(state: AiFocusState): Session | null {
  const focused =
    state.activeId != null ? (state.activePane[state.activeId] ?? state.activeId) : null;
  if (focused == null) return null;
  const session = state.sessions.find((s) => s.id === focused);
  if (!session) return null;
  if (session.status !== "connected" || session.rustId == null) return null;
  if (!isTerminalSession(session)) return null;
  return session;
}

/** 把可用会话定格为不可变目标快照。前提：rustId 已落地（未连接不可捕获）、
 * 带 PTY 终端（ftp/ftps 不可捕获）——违反即抛错（调用方先过
 * resolveFocusedTerminal，此处是防御性闸门）。 */
export function captureAiTarget(session: Session): AiScopeTarget {
  if (session.rustId == null) {
    throw new Error("captureAiTarget: session has no live connection");
  }
  if (!isTerminalSession(session)) {
    throw new Error("captureAiTarget: session has no terminal (ftp/ftps)");
  }
  return {
    paneSessionId: session.id,
    rootTabId: session.paneOf ?? session.id,
    rustId: session.rustId,
    connectionEpoch: currentEpoch(session),
    kind: targetKind(session),
    hostId: targetHostId(session),
  };
}

/** 目标是否仍指向原连接（pane id 定位 + kind/host/rustId/epoch 四元全等）。
 * 任一失配即死：关标签/关 pane（会话已移除）、重连（rustId+epoch 双变）、
 * shell_exit（rustId 清空 + epoch +1）。 */
export function isAiTargetLive(target: AiScopeTarget, state: AiFocusState): boolean {
  const session = state.sessions.find((s) => s.id === target.paneSessionId);
  if (!session) return false;
  return (
    target.rustId === session.rustId &&
    target.connectionEpoch === currentEpoch(session) &&
    target.kind === targetKind(session) &&
    target.hostId === targetHostId(session)
  );
}
