// DiagnosePanel（Task 13，核心卖点 UI）：侧栏流式「原因 / 修复命令」。
// * 诊断（exit_code≠0 自动开）与选中解释（右键）共用本面板；
// * 流式渲染：普通文本 + ``` 代码块两种块——代码块带「插入终端」按钮 =
//   danger 分级标注（classify）+ 分档确认（green 直插 / yellow 确认 /
//   red 二次确认红字），插入 = scope 通道 ai_scope_insert（一次性 actionId；
//   Task 3 插入隔离）——生成于哪个终端就只能插回哪个终端，跨目标禁用并给
//   「回到原终端」affordance。代码块行组件已抽为公共 InsertRow（Phase 2 B1：
//   ⌘J NL 命令条共用同一危险确认状态机——安全面单一来源）；
// * 脱敏口径（fix 1/5 M-1 定案）：面板命令区显示**原文**（本地行为，明文不出
//   本机）；发送给模型的请求体**按规则脱敏，可能漏报**（aiStore.run 内 redact 后才装配
//   messages——见 aiStore 步骤 3），面板以「已脱敏 N 处」标注外发侧命中；
// * 错误面：noProvider/noKey → 「去设置」按钮（App 注入 openSettings）；
//   request → 端点错误原文 + 重试；abort → 停止按钮（AbortController）；
// * 头部身份（Task 3）：主机 + provider/model + 后端捕获的账号@端点（scope）+
//   PROD 徽标 + 连接失效标记；重连换代 → 旧对话只读横幅（历史可见）。
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { useAiStore, useSessionAi } from "./aiStore";
import { activeProvider } from "./settings";
import { CodeBlockRow, defaultInserter, type InsertTarget, type TerminalInserter } from "./InsertRow";
import { MarkdownText } from "./Markdown";
import { isAiTargetLive } from "../session/aiTarget";
import { useSessionStore } from "../session/SessionStore";
import { useTerminalFocus } from "../terminal/terminalFocus";
import {
  DEFAULT_AI_EXEC_MODE,
  awaitingPlanSteps,
  needsModeUpgrade,
  planStepsOf,
  type AiExecMode,
  type PlanStepStatus,
} from "./aiModes";
import { HOST_TOOL_PREFIX } from "./mcpTools";
import { useAiPolicyStore } from "./aiPolicyStore";

/** 工具返回文本在面板里的显示上限（**发给模型的完整文本不截断**——
 *  截断只发生在渲染面；MCP 侧本身有 1 MiB 上限）。 */
export const TOOL_RESULT_DISPLAY_LIMIT = 2000;

/** 工具返回文本的截断展示（超限则补「…（已截断）」）。 */
export function truncateToolResult(text: string, limit = TOOL_RESULT_DISPLAY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}${i18n.t("ai.tool.truncated")}`;
}

/** 从 markdown 形态的回复中提取 ``` 围栏代码块（位置 + 内容），供插终端按钮。 */
export interface AnswerCodeBlock {
  code: string;
}

export function extractCodeBlocks(answer: string): AnswerCodeBlock[] {
  const blocks: AnswerCodeBlock[] = [];
  const re = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const code = m[1].replace(/\r?\n$/, "");
    if (code.trim() !== "") blocks.push({ code });
  }
  return blocks;
}

/** 回复渲染：按围栏代码块切分（流式过程中未闭合的尾部代码块也即时呈现）。
 *  binding 在位 = scope 通道（每个代码块按序号领一次性 actionId）；缺省 =
 *  legacy rustId 直写通道。 */
export function AnswerView({
  answer,
  rustId,
  binding = null,
  inserter,
  disabled = false,
  onInserted,
}: {
  answer: string;
  rustId: string | null;
  /** 本轮 run 的插入绑定（target + scopeId + runId）；null = legacy 通道。 */
  binding?: { target: InsertTarget["target"]; scopeId: string; runId: string } | null;
  inserter: TerminalInserter;
  disabled?: boolean;
  /** 插入成功回调（焦点交还 xterm；本面板仅在终端视图挂载，无需切视图）。 */
  onInserted?: () => void;
}) {
  const parts: { kind: "text" | "code"; content: string }[] = [];
  const re = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    if (m.index > last) parts.push({ kind: "text", content: answer.slice(last, m.index) });
    parts.push({ kind: "code", content: m[1].replace(/\r?\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < answer.length) parts.push({ kind: "text", content: answer.slice(last) });

  let codeIndex = -1;
  return (
    <div className="ai-answer" data-testid="ai-answer">
      {parts.map((p, i) => {
        if (p.kind === "text") return <MarkdownText key={i} content={p.content} />;
        codeIndex += 1;
        const insertTarget: InsertTarget | null = binding
          ? { ...binding, blockIndex: codeIndex }
          : null;
        return (
          <CodeBlockRow
            key={i}
            code={p.content}
            rustId={rustId}
            insertTarget={insertTarget}
            inserter={inserter}
            disabled={disabled}
            onInserted={onInserted}
          />
        );
      })}
    </div>
  );
}

export function DiagnosePanel({
  sessionId,
  onOpenSettings,
  inserter = defaultInserter,
}: {
  /** 面板所属会话（方案 A 会话作用域：读写都落自己那份切片）。 */
  sessionId: string;
  onOpenSettings: () => void;
  inserter?: TerminalInserter;
}) {
  const { t } = useTranslation();
  const slice = useSessionAi(sessionId);
  const {
    request,
    status,
    answer,
    errorKind,
    error,
    redactions,
    settingsUsed,
    usage,
    modelUsed,
    elapsedMs,
    messages,
    target,
    scope,
    draft,
    conversationReadonly,
  } = slice;
  // 执行模式（2026-11-04 第一步）：会话级，缺省 = plan（只产计划、不执行）。
  const mode: AiExecMode = slice.mode ?? DEFAULT_AI_EXEC_MODE;
  // 计划步骤清单（plan 模式下登记的执行类动作；跨 run 累积、按命令去重）。
  const planSteps = planStepsOf(slice);
  // Manual 档（第二步）：待确认的执行步骤（登记后既没执行也没拒绝）。
  const awaitingSteps = awaitingPlanSteps(slice);
  // plan 档登记的步骤（后端按**登记时的档位**判定执行权 → plan 档登记的执行
  // 不了；手动档点「执行」时先由后端升档）。plan 档下没有
  // 执行钮——但要说清楚出路（切到「手动」档）。
  const upgradableSteps = planSteps.filter(
    (s) => s.status === "planned" && needsModeUpgrade(s),
  );
  const manualMode = mode === "manual";
  /** 自动档降级待确认的步骤（登记为手动档）——它们要按「待确认卡」呈现。
   *  **只在自动档下算**：切回规划档后这些步骤不可执行（规划档不提供执行
   *  入口，后端也会拒）——那时它们回到「清单」形态，别挂着执行钮让人
   *  点了个寂寞。 */
  const hasDowngradedStep =
    mode === "auto" &&
    planSteps.some((s) => (s.registeredMode ?? "plan") === "manual" && s.status === "planned");
  /** 步骤状态文案（五态：待执行 / 执行中 / 已完成 / 失败 / 已拒绝）。 */
  const planStatusText = (status: PlanStepStatus): string => {
    if (status === "executing") return t("ai.plan.statusExecuting");
    if (status === "done") return t("ai.plan.statusDone");
    if (status === "failed") return t("ai.plan.statusFailed");
    if (status === "rejected") return t("ai.plan.statusRejected");
    return t("ai.plan.statusPlanned");
  };
  // 待确认的工具调用（批次五 P2）：模型发起、**用户点执行才真跑**。
  const pendingToolCalls = slice.pendingToolCalls ?? [];
  const runningToolCallId = slice.runningToolCallId ?? null;
  // 会话面（PROD 徽标；目标存活态随会话表变化重渲染）
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId));
  const sessions = useSessionStore((s) => s.sessions);
  // 目标失活（断开/shell_exit/重连换代）→ 头部标记 + 插入面全禁（scope 已撤）
  const targetDead = target != null && !isAiTargetLive(target, {
    activeId: null,
    activePane: {},
    sessions,
  });
  // 追问草稿在 store（面板关闭保留；Task 3 对话语义）
  const setDraft = useAiStore((s) => s.patchDraft);
  const newConversation = useAiStore((s) => s.newConversation);

  // 插入成功：焦点交还 xterm——2026-10-16 用户反馈「插完还得再点一下才能执行」。
  // 定向请求（Task 2 terminalFocus）：指名绑定 pane 的终端响应，用户若已切走
  // 则不抢焦点。
  const onInserted = () => useTerminalFocus.getState().request(sessionId);

  // 展示用轮次：正常走 messages；**兜底**——messages 为空但 answer 非空时，
  // 把 answer 当作单条 assistant 轮（会话状态可能来自旧路径/恢复）。
  const threadTurns =
    messages.length > 0
      ? messages
      : answer !== ""
        ? [{ role: "assistant" as const, content: answer }]
        : [];

  // 「待看」徽标口径：面板渲染 = 用户已看到（MainArea 只在所属会话激活时
  // 挂载本组件，key=sessionId——切走再切回会重挂并再次 markSeen，无害）。
  // 依赖必须含 request：本组件在终端视图无条件挂载（内部才判 null）——
  // 同会话首失败时 request 从无到有，依赖不变则 effect 不重跑，徽标常驻
  // （真机验收 2026-10-19 抓到的漏标记时序）。
  /** 追问输入条：面板打开时自动聚焦（真机 2026-11-03 验收发现焦点留在终端）。 */
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /** 对话流滚动跟随（2026-11-12 用户报障「消息显示逻辑一会上面一会下面」
   *  的另一半）：此前完全没有滚动跟随——长对话里新回复落在折线以下，界面
   *  上「什么都没发生」。现在：新消息/流式增长时贴到底部；**用户往上翻看
   *  历史时不抢滚动**（贴底判定），他回到底部才恢复跟随。 */
  const threadRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  /** 是否显示「回到最新」按钮（用户往回翻看历史时出现）。 */
  const [showJump, setShowJump] = useState(false);
  const onThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    // 距底部 24px 内算「还在底部」；否则视为用户主动上翻，停止跟随。
    stickBottom.current = gap < 24;
    setShowJump(gap >= 24);
  };
  /** 一键回到最新：滚到底 + 恢复自动跟随（此前往上翻了只能一路拖回来）。 */
  const jumpToLatest = () => {
    const el = threadRef.current;
    if (!el) return;
    stickBottom.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  };
  useEffect(() => {
    const el = threadRef.current;
    if (!el || !stickBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, answer, status, pendingToolCalls.length, planSteps.length]);
  // 窗口尺寸变化 → 对话重排、内容变高 → 重新贴底（否则变窄后新消息落到
  // 折线以下，界面上看着「什么都没发生」；2026-11-12 守卫在 900px 窄窗
  // 实测抓到）。用户已上翻历史时不抢滚动。
  useEffect(() => {
    const onResize = () => {
      const el = threadRef.current;
      if (!el || !stickBottom.current) return;
      el.scrollTop = el.scrollHeight;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const markSeen = useAiStore((s) => s.markSeen);
  useEffect(() => {
    if (sessionId && request) markSeen(sessionId);
  }, [sessionId, request, markSeen]);

  const abort = useAiStore((s) => s.abort);
  const run = useAiStore((s) => s.run);
  const close = useAiStore((s) => s.close);
  const resolveToolCall = useAiStore((s) => s.resolveToolCall);
  const resolvePlanStep = useAiStore((s) => s.resolvePlanStep);
  const interrupt = useAiStore((s) => s.interrupt);
  const setMode = useAiStore((s) => s.setMode);
  /** 自动档授权（第三步）：当前目标主机是否被授权自动执行。
   *  null = 还没查完（下拉不禁用、不给提示）；本地会话恒 false。
   *  授权态**订阅** policy store（2026-11-08 审计 A6）：此前是挂载时一次性
   *  快照，设置页里开/关授权后回到面板仍显示旧态，要切会话重挂才刷新。 */
  const hostId = target?.hostId ?? null;
  const isLocal = target?.kind === "local";
  const aiPolicies = useAiPolicyStore((s) => s.policies);
  const [authChecked, setAuthChecked] = useState(false);
  const autoAuthorized: boolean | null = !authChecked
    ? null
    : hostId != null && !isLocal
      ? aiPolicies.some((p) => p.hostId === hostId && p.autoEnabled)
      : false;
  useEffect(() => {
    // 2026-11-07 档位改下拉：自动执行选项**常驻可见**，未授权时要置灰并说明
    // 原因——授权态必须在挂载时就查（旧段控只在切到自动时才查，懒查询让
    // 「可点但降级」的坑藏进下拉里）。挂载/目标变化时重查一次（查完前保持
    // null 免得「未授权」提示闪现）；store 订阅保证设置页改动即时回流。
    setAuthChecked(false);
    if (isLocal || hostId == null) {
      setAuthChecked(true);
      return;
    }
    let alive = true;
    void useAiPolicyStore
      .getState()
      .refresh()
      .catch(() => {
        // 拉不到（非 Tauri/后端不可达）= 当作未授权（fail-closed）。
      })
      .finally(() => {
        if (alive) setAuthChecked(true);
      });
    return () => {
      alive = false;
    };
  }, [hostId, isLocal]);

  const running = status === "running";
  const canInterrupt = running && slice.streamStartedRunId === slice.runId && slice.runId != null;
  // 输入禁用面（2026-11-06 A 方案「打断插话」）：**运行中不再禁输入**——
  // 用户随时可以打字，点发送 = 自动停止当前回复 + 插话继续（interrupt）。
  // 其余禁用面不变：
  // * 外部 MCP 工具挂起 / 执行步骤待处置 → 禁（那次模型 tool call 还没被
  //   回答，插新的一轮会让 provider 协议缺 tool 消息，400）；
  // * 旧对话只读 → 禁（续问须新对话）。
  const inputDisabled =
    conversationReadonly ||
    pendingToolCalls.length > 0 ||
    runningToolCallId !== null ||
    slice.runningHostToolCallId != null ||
    awaitingSteps.length > 0 ||
    planSteps.some((step) => step.status === "executing");

  // **输入框自动聚焦**（2026-11-03 真机验收抓到的缺陷）：面板打开后焦点仍
  // 留在终端的 xterm textarea —— 用户以为在面板里问，第一句话却被**打进
  // 终端并执行**（真机截图实证）。面板一开就该把焦点交给输入框。
  //
  // 实现按 WebKitGTK 的老规矩来：一次性 focus() 会被吞 → rAF 连帧重试，
  // 命中 activeElement 即停（至多 10 帧）。禁用态不抢焦点（用户正在处置
  // 工具调用时抢走输入焦点会打断处置流程）。
  //
  // ★ 本 effect 必须在 `if (!sessionId || !request) return null` **之前**：
  // 早退之后再挂 hook 会让「先渲染 null、后出现 request」这条路径的 hook
  // 数量前后不一致 → React 报 "Rendered more hooks than during the
  // previous render"（2026-11-03 修这个缺陷时踩到）。
  useEffect(() => {
    if (inputDisabled) return;
    let raf = 0;
    let tries = 0;
    const tick = () => {
      const el = inputRef.current;
      if (!el) return;
      if (document.activeElement === el) return;
      el.focus();
      if (document.activeElement !== el && ++tries < 10) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sessionId, inputDisabled, request]);

  if (!sessionId || !request) return null;
  // 头部展示「实际生效」的 provider（首个未禁用，2026-10-16）——禁用的
  // 默认项不再冒名出现在头部；主机名居首（多会话方案 A 的归属标注）。
  const active = settingsUsed ? activeProvider(settingsUsed.providers) : null;
  // 插入绑定随轮（scopeId/runId 落在 assistant 轮上）；无 scope 的轮回落
  // legacy 通道（诊断 = 请求的 rustId；绑定目标在场却无 scope → 不回退直写，
  // 避免 Bypass 一次性动作账本）。
  const turnBinding = (m: (typeof messages)[number]) =>
    target && m.scopeId && m.runId
      ? { target, scopeId: m.scopeId, runId: m.runId }
      : null;
  const legacyRustId = target == null && request.kind === "diagnose" ? request.rustId : null;

  return (
    <aside className="ai-panel" data-testid="ai-panel" aria-label={t("ai.title")}>
      <div className="ai-panel-head">
        <span className="ai-panel-title">
          {request.kind === "diagnose"
            ? t("ai.panelDiagnose")
            : request.kind === "ask"
              ? t("ai.panelAsk")
              : t("ai.panelExplain")}
        </span>
        <span className="ai-panel-meta">
          {request.hostName ? `${request.hostName} · ` : ""}
          {scope ? `${scope.username ? `${scope.username}@` : ""}${scope.endpoint} · ` : ""}
          {session?.isProduction ? `${t("tabs.prodBadge")} · ` : ""}
          {targetDead ? `${t("ai.headerDisconnected")} · ` : ""}
          {active?.name ?? ""}
          {active?.model ? ` · ${active.model}` : ""}
        </span>
        <button
          className="ai-panel-new"
          data-testid="ai-new-conversation"
          title={t("ai.newConversation")}
          aria-label={t("ai.newConversation")}
          onClick={() => newConversation(sessionId)}
        >
          {t("ai.newConversation")}
        </button>
        <button
          className="ai-panel-close"
          data-testid="ai-close"
          aria-label={t("common.close")}
          onClick={() => close(sessionId)}
        >
          ✕
        </button>
      </div>

      {conversationReadonly && (
        // 重连换代（Task 3）：旧对话只读——历史可见，续问须新对话（openAsk 对
        // 新代数目标自动开新对话，或点头部「新对话」）。
        <p className="ai-readonly-notice" data-testid="ai-readonly-notice" role="status">
          {t("ai.conversationReadonlyNotice")}
        </p>
      )}

      {request.kind === "diagnose" && (
        <div className="ai-request" data-testid="ai-request">
          <span className="ai-exit-code" data-testid="ai-exit-code">
            {t("ai.exitCodeBadge", { code: request.exitCode ?? "?" })}
          </span>
          <pre className="ai-request-cmd" data-testid="ai-request-cmd">{request.command}</pre>
        </div>
      )}

      {redactions.length > 0 && (
        // 脱敏计数留在顶部——它说明「这次外发遮掉了多少」，属于**本次请求
        // 的事实**，跟上方的失败命令卡片同属「上下文」。
        // **停止 / 已中止 / 思考中 / 错误不在这里**：它们是「正在发生的事」，
        // 一律排在对话流下方（.ai-live-band）。2026-11-12 用户报障「消息显示
        // 逻辑一会上面一会下面」：此前这些活的指示被钉在面板顶部，而真正在
        // 发生的对话在下面的滚动区里——模型一开始输出，指示就从顶部跳到
        // 底部；对话变长后「停止」还会被顶出可视区。
        <div className="ai-status-row">
          <span className="ai-redactions" data-testid="ai-redactions">
            {t("ai.redacted", { count: redactions.reduce((n, r) => n + r.count, 0) })}
          </span>
        </div>
      )}

      {/* 对话气泡流（多轮追问会话，2026-11-02 批次二 C 项）：
          user 轮 = 用户诉求（含首轮装配后的诊断上下文），assistant 轮 = 模型
          回答（沿用 AnswerView：围栏代码块带插终端三档确认）。
          **流式中的当前回答也在 messages 里**（末条 assistant 轮内容原地增长），
          故此处不重复渲染 answer。
          **tool 轮**（批次五 P2）= 工具调用结果：user 侧显示「调用 <server>.<tool>」，
          assistant 侧显示工具返回文本（长文本在面板里截断显示）。 */}
      <div
        className="ai-thread"
        data-testid="ai-thread"
        ref={threadRef}
        onScroll={onThreadScroll}
      >
        {threadTurns.map((m, i) => {
          // **首轮诊断上下文不进气泡流**：它的内容是「退出码 + 命令 + 最长
          // 8KB 原始终端输出 + 主机备注」——正是给模型看的 prompt。直接渲染
          // 会把面板第一屏淹没（原始终端输出），而且与上方 .ai-request 区块
          // 展示的退出码/命令重复。模型侧仍收到完整上下文（messages 里原样
          // 保留），这里只是**不把它当「用户说的话」显示**。
          const isDiagnosticContext = i === 0 && m.role === "user" && request.kind === "diagnose";
          if (isDiagnosticContext) return null;
          if (m.role === "tool") {
            // 内建主机工具（ottr_ 前缀）没有 MCP server 名——用主机工具标签，
            // 免得渲染成「调用 .ottr_exec_command」这种半截话。
            const isHostTool = (m.toolName ?? "").startsWith(HOST_TOOL_PREFIX);
            return (
              <Fragment key={`t${i}`}>
                <div className="ai-bubble ai-bubble-user" data-testid="ai-msg-tool-call">
                  {isHostTool
                    ? t("ai.tool.hostCallLabel", { tool: m.toolName ?? "" })
                    : t("ai.tool.callLabel", {
                        server: m.serverName ?? "",
                        tool: m.toolName ?? "",
                      })}
                </div>
                <div
                  className="ai-bubble ai-bubble-assistant"
                  data-testid="ai-msg-tool-result"
                >
                  <pre className="ai-tool-result" data-testid="ai-tool-result-text">
                    {truncateToolResult(m.content)}
                  </pre>
                </div>
              </Fragment>
            );
          }
          return m.role === "user" ? (
            <div key={`u${i}`} className="ai-bubble ai-bubble-user" data-testid="ai-msg-user">
              {/* Ask 轮只显示用户的问题（2026-11-08 审计 A2）：首轮 content =
                  问题 + 输出尾 + 主机备注（给模型的装配面，输出尾可达 8KB），
                  整段渲染会把第一屏淹没。retryContent 挂着已脱敏的原问题
                  （追问轮与 content 同值；旧数据缺省回落 content）。 */}
              {request.kind === "ask" ? (m.retryContent ?? m.content) : m.content}
            </div>
          ) : (
            <div key={`a${i}`} className="ai-bubble ai-bubble-assistant" data-testid="ai-msg-assistant">
              <AnswerView
                disabled={status !== "done"}
                answer={m.content}
                rustId={legacyRustId}
                binding={turnBinding(m)}
                inserter={inserter}
                onInserted={onInserted}
              />
            </div>
          );
        })}

        {/* 待确认的工具调用（批次五 P2）：**模型发起、用户点执行才真跑**
            （与既有「AI 只给建议、用户执行」的安全模型一致——没有自动执行开关）。
            卡片：服务器名 + 工具名 + 参数（代码块）+ 执行/拒绝两钮。
            目标限制说明（Task 3）：MCP 工具在服务器侧执行，超出本面板绑定的
            终端——工具可用性照旧（用户逐次审批即安全模型），但限制必须说清。 */}
        {pendingToolCalls.length > 0 && (
          <div className="ai-tool-pending" data-testid="ai-tool-pending">
            <p className="ai-tool-pending-hint" data-testid="ai-tool-awaiting">
              {t("ai.tool.awaiting")}
            </p>
            <p className="settings-hint" data-testid="ai-tool-target-hint" role="status">
              {t("ai.tool.targetHint")}
            </p>
            {pendingToolCalls.map((p) => {
              const runningTool = runningToolCallId === p.id;
              const busy = runningToolCallId !== null;
              return (
                <div key={p.id} className="ai-tool-card" data-testid={`ai-tool-card-${p.id}`}>
                  <div className="ai-tool-card-head">
                    <span className="ai-tool-server" data-testid={`ai-tool-server-${p.id}`}>
                      {p.serverName}
                    </span>
                    <span className="ai-tool-name" data-testid={`ai-tool-name-${p.id}`}>
                      {p.tool}
                    </span>
                  </div>
                  <pre className="ai-tool-args" data-testid={`ai-tool-args-${p.id}`}>
                    {p.args}
                  </pre>
                  <div className="ai-tool-card-actions">
                    <button
                      type="button"
                      className="btn-accent"
                      data-testid={`ai-tool-approve-${p.id}`}
                      disabled={busy}
                      onClick={() => void resolveToolCall(sessionId, p.id, true)}
                    >
                      {runningTool ? t("ai.tool.running") : t("ai.tool.approve")}
                    </button>
                    <button
                      type="button"
                      data-testid={`ai-tool-reject-${p.id}`}
                      disabled={busy}
                      onClick={() => void resolveToolCall(sessionId, p.id, false)}
                    >
                      {t("ai.tool.reject")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 计划清单（2026-11-04 第一步）/ 待确认卡（第二步 Manual 模式）：
            plan 档：模型提出的执行类动作**只登记、不执行**——摊开给用户看：
            命令原文 + 危险徽章（复用 danger.ts 的分档）+ 状态点。
            manual 档：同一条清单升级成**待确认卡**（仿 .ai-tool-pending 的
            插法，作为 thread 内的一块，不另起浮层）——执行/拒绝两钮 + 执行
            结果就地展示。**plan 档不提供执行钮**（后端也会拒，前端不暴露
            入口）。模式切换时步骤不丢：清单 ↔ 待确认卡只是同一批数据的两种
            呈现。 */}
        {planSteps.length > 0 && (
          <div className="ai-plan" data-testid="ai-plan">
            <p className="ai-plan-hint" data-testid="ai-plan-title">
              {manualMode || hasDowngradedStep ? t("ai.plan.confirmTitle") : t("ai.plan.title")}
            </p>
            {(manualMode || hasDowngradedStep) && (
              <p className="ai-plan-hint" data-testid="ai-plan-confirm-hint">
                {t("ai.plan.confirmHint")}
              </p>
            )}
            {!manualMode && !hasDowngradedStep && (awaitingSteps.length > 0 || upgradableSteps.length > 0) && (
              // 有待确认的命令、但当前不在 manual 档 → 说清楚怎么处置
              // （plan 档按契约不提供执行钮）。**plan 档登记的步骤也算**
              // （它在手动档点「执行」时会先由后端升档再执行）——
              // 否则用户看不到「切到手动档就能跑」这条出路。
              <p className="ai-plan-hint" data-testid="ai-plan-mode-hint" role="status">
                {t("ai.plan.switchToManual")}
              </p>
            )}
            <ul
              className="ai-plan-list"
              aria-label={manualMode || hasDowngradedStep ? t("ai.plan.confirmTitle") : t("ai.plan.title")}
            >
              {planSteps.map((s) => {
                // 执行中：钮置灰 + 状态 executing（重复点击的第一道闸）。
                const busy = s.status === "executing";
                // 跨步骤互斥的 UI 面（2026-11-08 审计 A1）：同对话里已有步骤
                // 在执行时，其余待确认卡片的执行/拒绝一并置灰——store 侧有
                // 同款闸（resolvePlanStep 入口），置灰让原因可见。
                const otherExecuting =
                  !busy && planSteps.some((x) => x.status === "executing");
                // **自动档的降级步骤也给执行/拒绝钮**：自动档把非白名单命令
                // 降级成「等你确认」，那一步就登记为手动档——不给钮 = 降级
                // 成了死路（用户永远点不动）。
                const stepNeedsConfirm =
                  manualMode || (mode === "auto" && (s.registeredMode ?? "plan") === "manual");
                const showActions = stepNeedsConfirm && (s.status === "planned" || busy);
                return (
                  <li
                    key={s.id}
                    className="ai-plan-step"
                    data-testid={`ai-plan-step-${s.id}`}
                    data-danger={s.danger}
                    data-status={s.status}
                  >
                    <span
                      className="ai-plan-dot"
                      data-testid={`ai-plan-dot-${s.id}`}
                      data-status={s.status}
                      aria-hidden="true"
                    />
                    <span className="ai-plan-cmd" data-testid={`ai-plan-cmd-${s.id}`}>
                      {s.command}
                    </span>
                    <span
                      className={`ai-level ai-level-${s.danger}`}
                      data-testid={`ai-plan-level-${s.id}`}
                    >
                      {t(
                        s.danger === "red"
                          ? "ai.levelRed"
                          : s.danger === "yellow"
                            ? "ai.levelYellow"
                            : "ai.levelGreen",
                      )}
                    </span>
                    <span className="ai-plan-status" data-testid={`ai-plan-status-${s.id}`}>
                      {planStatusText(s.status)}
                    </span>
                    {showActions && (
                      <span className="ai-plan-actions">
                        <button
                          type="button"
                          className="btn-accent"
                          data-testid={`ai-plan-run-${s.id}`}
                          disabled={busy || otherExecuting}
                          // 无障碍：按钮的可读名带上命令原文——一屏多张卡时，
                          // 读屏用户能听出「执行」的是哪一条。
                          aria-label={`${busy ? t("ai.plan.running") : t("ai.plan.run")}: ${s.command}`}
                          onClick={() => void resolvePlanStep(sessionId, s.id, true)}
                        >
                          {busy ? t("ai.plan.running") : t("ai.plan.run")}
                        </button>
                        <button
                          type="button"
                          data-testid={`ai-plan-reject-${s.id}`}
                          disabled={busy || otherExecuting}
                          aria-label={`${t("ai.plan.reject")}: ${s.command}`}
                          onClick={() => void resolvePlanStep(sessionId, s.id, false)}
                        >
                          {t("ai.plan.reject")}
                        </button>
                      </span>
                    )}
                    {s.result && (
                      // 执行结果就地展示（退出码 + 截断输出）；role=status 让
                      // 读屏在结果出现时播报一句。
                      <div
                        className="ai-plan-result"
                        data-testid={`ai-plan-result-${s.id}`}
                        role="status"
                      >
                        <span className="ai-plan-exit" data-testid={`ai-plan-exit-${s.id}`}>
                          {t("ai.plan.exitCode", { code: s.result.exitCode ?? "-" })}
                        </span>
                        {s.result.timedOut && (
                          // 超时要**单独说**：退出码「-」既可能是超时被中止，
                          // 也可能只是服务端没回退出码——两者的处置完全不同。
                          <span
                            className="ai-plan-timeout"
                            data-testid={`ai-plan-timeout-${s.id}`}
                          >
                            {t("ai.plan.timedOut")}
                          </span>
                        )}
                        {s.result.error && (
                          <span className="ai-plan-error" data-testid={`ai-plan-error-${s.id}`}>
                            {s.result.error}
                          </span>
                        )}
                        {s.result.stdout && (
                          <pre
                            className="ai-plan-output"
                            data-testid={`ai-plan-output-${s.id}`}
                          >
                            {s.result.stdout}
                          </pre>
                        )}
                        {s.result.stderr && (
                          <pre
                            className="ai-plan-output"
                            data-testid={`ai-plan-stderr-${s.id}`}
                          >
                            {s.result.stderr}
                          </pre>
                        )}
                        {s.result.truncated && (
                          <span
                            className="ai-plan-truncated"
                            data-testid={`ai-plan-truncated-${s.id}`}
                          >
                            {t("ai.tool.truncated")}
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* 「回到最新」：用户往上翻看历史时出现——一键回到底部并恢复自动跟随。
          此前没有这个入口：往上一翻就只能一路拖回来（或等新消息把内容顶下去）。 */}
      {showJump && (
        <div className="ai-jump-row" data-testid="ai-jump-row">
          <button
            className="ai-jump-latest"
            data-testid="ai-jump-latest"
            aria-label={t("ai.jumpToLatest")}
            onClick={jumpToLatest}
          >
            ↓ {t("ai.jumpToLatest")}
          </button>
        </div>
      )}

      {/* 活的状态带（2026-11-12 用户报障「消息显示逻辑一会上面一会下面」的
          修复）：停止 / 思考中 / 已中止 / 错误一律排在**对话流之下、输入框
          之上**——一个固定位置，不随对话长短挪窝，滚动时也不会被顶走。
          「思考中」紧贴最后一条消息，模型开始输出时它就地让位给正文，
          不再出现「指示在顶部、正文在底部」的割裂。 */}
      {(status === "error" ||
        status === "aborted" ||
        (status === "running" && (answer === "" || running))) && (
        <div className="ai-live-band" data-testid="ai-live-band">
          {status === "error" && (
            <div className="ai-error" data-testid="ai-error" role="alert">
              {errorKind === "noProvider" && (
                <>
                  <p>{t("ai.errNoProvider")}</p>
                  <button className="btn-accent" data-testid="ai-open-settings" onClick={onOpenSettings}>
                    {t("ai.openSettings")}
                  </button>
                </>
              )}
              {errorKind === "noKey" && (
                <>
                  <p>{t("ai.errNoKey")}</p>
                  <button className="btn-accent" data-testid="ai-open-settings" onClick={onOpenSettings}>
                    {t("ai.openSettings")}
                  </button>
                </>
              )}
              {errorKind === "request" && (
                <>
                  <p data-testid="ai-error-message">{error ?? t("ai.failed")}</p>
                  <button className="btn-accent" data-testid="ai-retry" onClick={() => void run(sessionId)}>
                    {t("ai.retry")}
                  </button>
                </>
              )}
            </div>
          )}
          <div className="ai-live-row">
            {status === "running" && answer === "" && (
              // aria-live=polite：只播状态短语，**不把流式正文塞进 live 区**——
              // 否则读屏会随着每个 token 反复播报正文（更糟）。
              <p className="ai-thinking" data-testid="ai-thinking" role="status" aria-live="polite">
                {t("ai.thinking")}
              </p>
            )}
            {running && (
              <button className="ai-stop" data-testid="ai-stop" onClick={() => abort(sessionId)}>
                {t("ai.stop")}
              </button>
            )}
            {status === "aborted" && (
              <span className="ai-aborted" data-testid="ai-aborted">
                {t("ai.aborted")}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 用量透明化（2026-11-02 批次一 B 项）：模型 · token · 耗时。
          端点不回 usage 时只显示模型与耗时（不显示 token 数）——透明化是
          增强项，拿不到就降级，绝不让面板空白。 */}
      {(status === "done" || status === "aborted") && (
        // 完成态播报：读屏用户需要知道「回答好了」（正文在气泡流里，不进 live）。
        <div className="ai-usage-row" data-testid="ai-usage" role="status" aria-live="polite">
          <span className="ai-usage-model">
            {modelUsed ?? active?.model ?? ""}
          </span>
          {usage && (
            <span className="ai-usage-tokens" data-testid="ai-usage-tokens">
              {t("ai.usageTokens", {
                input: usage.inputTokens,
                output: usage.outputTokens,
              })}
            </span>
          )}
          {elapsedMs !== null && (
            <span className="ai-usage-elapsed" data-testid="ai-usage-elapsed">
              {t("ai.usageElapsed", { ms: elapsedMs })}
            </span>
          )}
        </div>
      )}

      {/* 执行方式（2026-11-07 用户反馈第三条：不许让用户切模式才能操作）：
          下拉框两档——**逐条确认（默认）**：AI 提出的命令以待确认卡出现，
          点「执行」= 授权这一条；**自动执行**：仅当主机已在设置授权时可选。
          原「规划」档从面板移除——确认卡本身就是看得见的计划（裁定可改）。
          贴输入框正上方不变（2026-11-05 反馈）；运行中保持可用：切换只影响
          下一轮（每轮链起时取一次档，工具描述与实际档位同源，M-5 纪律不变）。 */}
      <div className="ai-input-mode-row" data-testid="ai-input-mode-row">
        <select
          className="ai-mode-select"
          data-testid="ai-mode-switch"
          aria-label={t("ai.mode.label")}
          value={mode}
          onChange={(e) => setMode(sessionId, e.target.value as AiExecMode)}
        >
          <option value="manual">{t("ai.mode.confirm")}</option>
          {/* 自动档的前提是主机被授权（授权表默认全拒）——未授权时该选项
              禁用：模型提的命令会降级成逐条确认，用户会以为它在自动跑。 */}
          <option value="auto" disabled={autoAuthorized === false}>
            {t("ai.mode.auto")}
          </option>
        </select>
        {autoAuthorized === false && (
          // 未授权（或本地会话）：说清楚为什么「自动执行」置灰 + 去哪开。
          // 下拉里该选项常驻可见，禁用原因必须常显（role=status 读屏播报）。
          <span className="ai-mode-hint" data-testid="ai-mode-auto-hint" role="status">
            {isLocal ? t("ai.mode.autoLocalDenied") : t("ai.mode.autoNotAuthorized")}
          </span>
        )}
      </div>

      {/* 追问输入条（多轮追问会话，2026-11-02 批次二 C 项）：
          Enter 提交 / Shift+Enter 换行；运行中禁用输入（避免并发轮）；
          **有待确认的工具调用 / 待确认的执行步骤时同样禁用**（用户得先处置）；
          旧对话只读（重连换代）→ 输入禁用，提示另开新对话。 */}
      <div className="ai-followup-row">
        <textarea
          className="ai-followup-input"
          data-testid="ai-followup-input"
          ref={inputRef}
          rows={2}
          aria-label={
            request.kind === "ask" && messages.length === 0
              ? t("ai.askPlaceholder")
              : t("ai.followupPlaceholder")
          }
          placeholder={
            running
              ? t("ai.interruptPlaceholder")
              : request.kind === "ask" && messages.length === 0
                ? t("ai.askPlaceholder")
                : t("ai.followupPlaceholder")
          }
          value={draft}
          disabled={inputDisabled}
          onChange={(e) => setDraft(sessionId, e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送 / Shift+Enter 换行。textarea 的 Enter 默认是换行，
            // 这里在「无 Shift」时拦下并提交；Shift+Enter 保留原生换行。
            // IME 组字过程中的 Enter 是「上屏候选词」，不能当发送。
            if (e.key !== "Enter" || e.shiftKey) return;
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            const text = draft.trim();
            if (text === "") return;
            // 运行中 Enter = 打断插话（与按钮同语义）；空闲 = 普通发送。
            if (canInterrupt) {
              void interrupt(sessionId, text, slice.runId);
            } else if (!running) {
              void run(sessionId, text);
            } else {
              return;
            }
          }}
        />
        {/* 按钮恒为「发送」（2026-11-07 用户反馈第二条：文案不再随状态变）。
            回答中草稿非空点击 = 打断并插入（同 Enter 语义）；纯停止仍由状态
            行的「停止」钮完成。准备阶段（流未开始）不可打断——首轮提问不能
            被替换，钮短暂禁用。 */}
        <button
          className="btn-accent"
          data-testid="ai-followup-send"
          disabled={
            inputDisabled ||
            draft.trim() === "" ||
            (running && !canInterrupt)
          }
          onClick={() => {
            const text = draft.trim();
            if (text === "") return;
            if (running) {
              if (!canInterrupt) return;
              void interrupt(sessionId, text, slice.runId);
            } else {
              void run(sessionId, text);
            }
          }}
        >
          {t("ai.send")}
        </button>
      </div>
    </aside>
  );
}
