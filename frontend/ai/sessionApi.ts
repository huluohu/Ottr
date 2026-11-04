import { invoke } from "@tauri-apps/api/core";

/**
 * AI 目标作用域 API（feat/ask-ottr-orb Task 1，Rust 侧 desktop/src/commands/ai_session.rs）。
 *
 * 目标（AiScopeTarget）只是元数据：真实身份由 Rust 侧在 open 时按 rustId 从
 * 会话表捕获（runtime_id + 实际 endpoint/username），返回的 AiScope 携带后端
 * 捕获的身份面。insert 为一次性动作（actionId 重放即拒）、单行文本、绝不追加
 * 换行——普通击键 write_session 完全不经此路径。撤销/过期/锁定/断线后一切
 * 写面零字节。命令名契约由 desktop/tests/command_contract.rs 双面钉住。
 */
export interface AiScopeTarget {
  paneSessionId: string;
  rootTabId: string;
  rustId: string;
  connectionEpoch: number;
  kind: "ssh" | "local";
  hostId: number | null;
}

export interface AiScope extends AiScopeTarget {
  scopeId: string;
  endpoint: string;
  username: string | null;
}

export const aiSessionApi = {
  open: (target: AiScopeTarget, conversationId: string, requestId: string): Promise<AiScope> =>
    invoke<AiScope>("ai_scope_open", { target, conversationId, requestId }),
  context: (scopeId: string, bytes: number): Promise<{ tail: string; notes: string | null }> =>
    invoke<{ tail: string; notes: string | null }>("ai_scope_context", { scopeId, bytes }),
  insert: async (scopeId: string, actionId: string, text: string): Promise<void> => {
    await invoke("ai_scope_insert", { scopeId, actionId, text });
  },
  revoke: async (scopeId: string): Promise<void> => {
    await invoke("ai_scope_revoke", { scopeId });
  },
};
