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
 * 一类（按模式分派）。**执行闸门在后端**——档位由前端在登记时传上去、后端
 * **原样落账**，执行面按**落账档位**判定（plan 模式下后端**一步都不执行**，
 * 只登记计划步骤并回 planned=true + stepId）。注意：**「用户已确认」这一环
 * 是 UI 事实，后端无从核验**（设计取舍，见设计文档 §3.6 的「不可承诺的边界」）。
 *
 * 2026-11-04 第二步（Manual 模式）扩写：新增 `ai_scope_run_step`——真正执行
 * 一条**已登记**的计划步骤。前端只传 **scopeId + stepId + actionId**（不传命令
 * 原文）：执行对象 = 登记簿里那条命令原文（前端改写命令的能力留给第三步），
 * actionId 必须与登记时那条一致（防串改），scope 决定目标（切到别的终端后，
 * 原对话的待确认卡仍指向原终端——后端按 scope 校验）。
 *
 * 2026-11-04 修补 I-1：新增 `ai_scope_upgrade_step`——把一条 plan 档登记的
 * 步骤升到 manual 档。**命令原文只从后端登记簿里取**（本命令**没有命令
 * 参数**：前端不传命令，也无从改写）——「从登记到执行」的最后一跳，命令文本
 * 的来源仍然只有第一次登记那一条。
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

/**
 * 执行结果（`ai_scope_run_step` 回包，2026-11-04 第二步 Manual 模式）。
 *
 * 字段名以 Rust 的 camelCase 序列化面为准（`#[serde(rename_all = "camelCase")]`）：
 * `step_id → stepId`、`exit_code → exitCode`。
 *
 * * `executed` 恒 true（成功路径；后端拒绝时整个命令抛错，不产生本结构）；
 * * `exitCode` 为 null = 没有退出码（被信号杀掉 / 超时等）；
 * * `truncated` = 输出被后端 64 KiB 上限截断；
 * * `timedOut` = **消费侧硬超时命中**（命令被中止、通道已显式关闭）——
 *   单独一个布尔位：`exitCode === null` 单独看分不出「超时被中止」与
 *   「服务端没回退出码」，用户与模型要看到的是**不同**的提示；
 * * `message` = 面向模型的一句话摘要（超时 / 失败 / 成功 + 截断提示）。
 */
export interface AiScopeRunResult {
  executed: boolean;
  stepId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  message: string;
}

/**
 * 档位升级回包（`ai_scope_upgrade_step`，2026-11-04 修补 I-1）。
 *
 * * `stepId` = **新登记**的那条 manual 档步骤 id（执行它 = 执行登记簿里的
 *   命令原文）；
 * * `actionId` = 新登记用的 actionId（**一次性**：后端已消费）；
 * * `mode` = 升级后的档位（恒为 `"manual"`）。
 */
export interface AiScopeUpgradeOutcome {
  stepId: string;
  actionId: string;
  mode: AiExecMode;
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
  /**
   * 执行一条**已登记**的计划步骤（第二步 Manual 模式）。
   *
   * 只在 manual 档允许（plan/auto 后端一律拒）；只能执行本 scope 登记簿里的
   * 步骤（前端传不来任意命令）；actionId 必须与登记时那条一致（防串改）；
   * 目标由 scope 决定（**不是**当前焦点终端——切到别的终端后原卡仍打原目标）。
   */
  runStep: (scopeId: string, stepId: string, actionId: string): Promise<AiScopeRunResult> =>
    invoke<AiScopeRunResult>("ai_scope_run_step", { scopeId, stepId, actionId }),
  /**
   * **档位升级**（把 plan 档登记的步骤升到 manual 档，2026-11-04 修补 I-1）。
   *
   * * **不传命令**：命令原文**只从后端登记簿里取**（前端手里那份副本不再
   *   被送去重新登记——那条路径会让「执行对象」的命令文本来源变回前端）；
   * * `stepId` = 待升级的那条（必须命中该 scope 的登记簿）；
   * * `actionId` = **新登记用的** actionId（一次性：后端在作用域动作账本里
   *   消费它；同一个 id 二次升级/二次执行都拒）。
   *
   * 返回新的 `stepId` + `actionId` → 前端再调 {@link runStep} 执行它
   * （只升级、不执行）。
   */
  upgradeStep: (
    scopeId: string,
    stepId: string,
    actionId: string,
  ): Promise<AiScopeUpgradeOutcome> =>
    invoke<AiScopeUpgradeOutcome>("ai_scope_upgrade_step", { scopeId, stepId, actionId }),
};
