// AI 终端目标消费面（ask-ottr-orb Task 3）：把「目标解析 + 归焦 + 共享入口」
// 收口成单一来源——App（⌘K/菜单/快捷键）、Terminal 工具行、Ask Ottr 悬浮球
// 三个入口共用 openAskForFocusedTerminal，绝不各自解析目标（多入口分叉 =
// 插错终端的事故面）。
//
// 裁定：
// * 入口 fail-closed：resolveFocusedTerminal 无活目标（未连接/无 rustId/纯
//   文件会话）→ 不开面板 + 一句 toast 说明（既有 toastStore 模式，保持轻量），
//   绝不回退到根标签或最近活动标签（Task 2 铁律）。
// * focusOriginalPane = 插入面「回到原终端」affordance 的唯一实现：
//   激活绑定目标所属标签 + 把该标签的聚焦 pane 指回绑定 pane + 回终端视图。
import i18n from "../i18n";
import { showToast } from "../ui/toastStore";
import { useSessionStore, type AiFocusState, type AiScopeTarget } from "../session/SessionStore";
import { captureAiTarget, resolveFocusedTerminal } from "../session/aiTarget";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useAiStore, type AskRequest } from "./aiStore";

/** 聚焦 pane 会话 id（activePane[activeId] ?? activeId；仅 activeId 非空）。
 *  与 session/aiTarget.resolveFocusedTerminal 的定位口径一致，但不做可用性
 *  过滤——面板挂载/插入禁用判定需要「聚焦在哪」，不是「聚焦是否可用」。 */
export function focusedPaneIdOf(s: Pick<AiFocusState, "activeId" | "activePane">): string | null {
  return s.activeId != null ? (s.activePane[s.activeId] ?? s.activeId) : null;
}

/** SessionStore 全量切片 → isAiTargetLive 的入参面（纯函数不拖多余字段）。 */
export function sessionFocusState(): AiFocusState {
  const s = useSessionStore.getState();
  return { activeId: s.activeId, activePane: s.activePane, sessions: s.sessions };
}

/** 「回到原终端」：把激活标签切到绑定目标所属标签，并把该标签的聚焦 pane
 *  指回绑定 pane，随后回终端视图（AI 面板/⌘J 面板可能在任意视图上）。 */
export function focusOriginalPane(target: AiScopeTarget): void {
  const st = useSessionStore.getState();
  if (!st.sessions.some((s) => s.id === target.paneSessionId)) return; // pane 已移除：无处可回
  const root =
    st.sessions.find((s) => s.id === target.rootTabId) != null
      ? target.rootTabId
      : (st.sessions.find((s) => s.id === target.paneSessionId)?.paneOf ?? target.rootTabId);
  st.setActivePane(root, target.paneSessionId);
  st.setActive(root);
  useWorkspaceStore.getState().openMainView("terminal");
}

/**
 * Ask Ottr 共享入口（三入口单一来源）：对**聚焦 pane**的活终端开「提问」态
 * 面板。目标在此刻定格（captureAiTarget），面板/对话/插入全部绑定它。
 *
 * 返回是否开了面板（false = 无活目标，已 toast 说明——fail-closed 不静默）。
 */
export function openAskForFocusedTerminal(): boolean {
  // Task 2 的解析闸门原样复用：聚焦 pane 无活终端（未连接/无 rustId/ftp）→
  // fail-closed + toast，绝不回退到根标签或最近活动标签。
  const session = resolveFocusedTerminal(useSessionStore.getState());
  if (!session) {
    showToast(i18n.t("ai.askNoTarget"), "error");
    return false;
  }
  let target: AiScopeTarget;
  try {
    target = captureAiTarget(session); // 防御性闸门（解析已过，理论不抛）
  } catch {
    showToast(i18n.t("ai.askNoTarget"), "error");
    return false;
  }
  const req: AskRequest = {
    kind: "ask",
    sessionId: session.id,
    rustId: session.rustId,
    hostId: target.hostId,
    hostName: session.hostName,
    target,
  };
  useAiStore.getState().openAsk(req);
  return true;
}
