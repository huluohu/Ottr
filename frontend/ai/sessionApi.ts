import { invoke } from "@tauri-apps/api/core";
import type { AiExecMode } from "./aiModes";

export type { AiExecMode };

/**
 * AI 目标作用域 API（feat/ask-ottr-orb Task 1，Rust 侧 desktop/src/commands/ai_session.rs）。
 *
 * 目标（AiScopeTarget）只是元数据：真实身份由 Rust 侧在 open 时按 rustId 从
 * 会话表捕获（runtime_id + 实际 endpoint/username），返回的 AiScope 携带后端
 * 捕获的身份面。insert 为一次性动作（actionId 重放即拒）、单行文本、绝不追加
 * 换行——普通击键 write_session 完全不经此路径。撤销/过期/锁定/断线后一切
 * 写面零字节。命令名契约由 desktop/tests/command_contract.rs 双面钉住。
 *
 * 2026-11-04 第一步（Plan 模式）扩写：只读两类（列目录 / 读文件）+ 执行类
 * 一类（按模式分派）。**执行闸门在后端**——前端传的 mode 只是提示，后端按
 * 传入的 mode 独立复核（前端可能被绕过）；plan 模式下后端**一步都不执行**，
 * 只登记计划步骤并回 planned=true + stepId。
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

/** 目录项（列目录回包；Rust 侧字段 is_dir → camelCase 序列化面 isDir）。 */
export interface AiScopeEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** 列目录回包。 */
export interface AiScopeListing {
  path: string;
  entries: AiScopeEntry[];
}

/** 读文件回包（truncated = 超长截断，模型只拿到截断后的内容）。 */
export interface AiScopeFile {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
}

/**
 * 执行类动作回包（按模式分派）：
 * * plan / manual（本步）→ `{executed:false, planned:true, stepId}`（**零执行**）；
 * * auto（本步未开放）→ 后端直接拒（抛错），不产生本结构。
 */
export interface AiScopeExecOutcome {
  executed: boolean;
  planned: boolean;
  stepId: string;
  message: string;
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
  /** 只读：列目录（SFTP；本地会话走本机 FS 面）。 */
  listDir: (scopeId: string, path: string): Promise<AiScopeListing> =>
    invoke<AiScopeListing>("ai_scope_list_dir", { scopeId, path }),
  /** 只读：读文件（路径规则沿用 MCP read_file 口径：绝对路径、无 ..）。 */
  readFile: (scopeId: string, path: string): Promise<AiScopeFile> =>
    invoke<AiScopeFile>("ai_scope_read_file", { scopeId, path }),
  /**
   * 执行类动作：按模式分派。
   * **plan 模式下后端不打开任何 exec channel**——只登记计划步骤 id 返回
   * （{executed:false, planned:true, stepId}）。
   */
  exec: (
    scopeId: string,
    actionId: string,
    command: string,
    mode: AiExecMode,
  ): Promise<AiScopeExecOutcome> =>
    invoke<AiScopeExecOutcome>("ai_scope_exec", { scopeId, actionId, command, mode }),
};
