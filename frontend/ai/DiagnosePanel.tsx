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
import { Fragment, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { useAiStore, useSessionAi } from "./aiStore";
import { activeProvider } from "./settings";
import { CodeBlockRow, defaultInserter, type InsertTarget, type TerminalInserter } from "./InsertRow";
import { MarkdownText } from "./Markdown";
import { isAiTargetLive } from "../session/aiTarget";
import { useSessionStore } from "../session/SessionStore";
import { useTerminalFocus } from "../terminal/terminalFocus";
import { SegmentedControl } from "../ui/SegmentedControl";
import { DEFAULT_AI_EXEC_MODE, planStepsOf, type AiExecMode } from "./aiModes";
import { HOST_TOOL_PREFIX } from "./mcpTools";

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
  const markSeen = useAiStore((s) => s.markSeen);
  useEffect(() => {
    if (sessionId && request) markSeen(sessionId);
  }, [sessionId, request, markSeen]);

  const abort = useAiStore((s) => s.abort);
  const run = useAiStore((s) => s.run);
  const close = useAiStore((s) => s.close);
  const resolveToolCall = useAiStore((s) => s.resolveToolCall);
  const setMode = useAiStore((s) => s.setMode);

  const running = status === "running";
  const inputDisabled =
    running || conversationReadonly || pendingToolCalls.length > 0 || runningToolCallId !== null;

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

      <div className="ai-status-row">
        {/* 执行模式（2026-11-04 第一步）：**放状态行**——头部 .ai-panel-meta 已
            是 flex:1 + ellipsis（面板最小宽 280px），塞不下第三组控件。
            用现成 SegmentedControl（禁裸 checkbox：全仓守卫 ui-no-native-controls）。 */}
        <SegmentedControl
          value={mode}
          options={[
            { value: "plan", label: t("ai.mode.plan") },
            { value: "auto", label: t("ai.mode.auto") },
            { value: "manual", label: t("ai.mode.manual") },
          ]}
          onChange={(v) => setMode(sessionId, v)}
          ariaLabel={t("ai.mode.label")}
          testid="ai-mode-switch"
        />
        {mode === "auto" && (
          // auto 本步尚未开放（主机授权表是第三步）——说清楚，不装作能用。
          <span className="ai-mode-hint" data-testid="ai-mode-auto-hint">
            {t("ai.mode.autoNotEnabled")}
          </span>
        )}
        {redactions.length > 0 && (
          <span className="ai-redactions" data-testid="ai-redactions">
            {t("ai.redacted", { count: redactions.reduce((n, r) => n + r.count, 0) })}
          </span>
        )}
        {running && (
          <button className="ai-stop" data-testid="ai-stop" onClick={() => abort(sessionId)}>
            {t("ai.stop")}
          </button>
        )}
        {status === "aborted" && <span className="ai-aborted">{t("ai.aborted")}</span>}
      </div>

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

      {status === "running" && answer === "" && (
        // aria-live=polite：只播状态短语，**不把流式正文塞进 live 区**——
        // 否则读屏会随着每个 token 反复播报正文（更糟）。
        <p className="ai-thinking" data-testid="ai-thinking" role="status" aria-live="polite">
          {t("ai.thinking")}
        </p>
      )}

      {/* 对话气泡流（多轮追问会话，2026-11-02 批次二 C 项）：
          user 轮 = 用户诉求（含首轮装配后的诊断上下文），assistant 轮 = 模型
          回答（沿用 AnswerView：围栏代码块带插终端三档确认）。
          **流式中的当前回答也在 messages 里**（末条 assistant 轮内容原地增长），
          故此处不重复渲染 answer。
          **tool 轮**（批次五 P2）= 工具调用结果：user 侧显示「调用 <server>.<tool>」，
          assistant 侧显示工具返回文本（长文本在面板里截断显示）。 */}
      <div className="ai-thread" data-testid="ai-thread">
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
              {m.content}
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

        {/* 计划清单（2026-11-04 第一步）：plan 模式下模型提出的执行类动作
            **只登记、不执行**——这里把步骤摊开给用户看：命令原文 + 危险徽章
            （复用 danger.ts 的分档）+ 状态点。仿 .ai-tool-pending 的插法：
            作为 thread 内的一块，不另起浮层。
            本步不实现「执行计划」按钮（第二步接 Manual）。 */}
        {planSteps.length > 0 && (
          <div className="ai-plan" data-testid="ai-plan">
            <p className="ai-plan-hint" data-testid="ai-plan-title">
              {t("ai.plan.title")}
            </p>
            <ul className="ai-plan-list">
              {planSteps.map((s) => (
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
                    {t("ai.plan.statusPlanned")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

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

      {/* 追问输入条（多轮追问会话，2026-11-02 批次二 C 项）：
          Enter 提交 / Shift+Enter 换行；运行中禁用输入（避免并发轮）；
          **有待确认的工具调用时同样禁用**（用户得先处置工具调用）；
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
            request.kind === "ask" && messages.length === 0
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
            void run(sessionId, text);
          }}
        />
        {running ? (
          <button className="ai-stop" data-testid="ai-followup-stop" onClick={() => abort(sessionId)}>
            {t("ai.stop")}
          </button>
        ) : (
          <button
            className="btn-accent"
            data-testid="ai-followup-send"
            disabled={draft.trim() === ""}
            onClick={() => {
              const text = draft.trim();
              if (text === "") return;
              void run(sessionId, text);
            }}
          >
            {t("ai.send")}
          </button>
        )}
      </div>
    </aside>
  );
}
