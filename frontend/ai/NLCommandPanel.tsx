// NLCommandPanel（Phase 2 B1，⌘J）：底部自然语言 → 命令输入条。
// * 交互骨架复用 palette/history 的 overlay 范式（Esc 关、点遮罩关、开时聚焦），
//   锚定改为**底部**（输入条语义：视线不离开终端下沿）；
// * 运行链在 useNlStore（nl2cmd.ts）：流式原文等宽渲染（生成中的命令成形过程
//   可见）→ done 后只去展示包裹，保留多行供安全检查 → 复用公共 InsertRow 渲染 danger 徽标
//   + 三档确认插终端（与诊断面板同一状态机——安全面单一来源）；
// * 插入目标 = **轮次自己的来源绑定**（Task 3）：生成时聚焦 pane 的不可变
//   目标 + 该轮 scope（ai_scope_insert 一次性 actionId）。聚焦 pane ≠ 轮次
//   来源 → 插入禁用 + 「原终端」标注（跨目标绝不静默改插，守卫在公共
//   InsertRow 生产面内）；无连接终端 → 同样禁用（不静默失败）；
// * 错误面：noProvider/noKey → 「去设置」；request → 端点消息 + 重试；
//   empty（sanitize 不可用，如 stop 截在围栏头）→ 说明 + 重试；
//   aborted → 已取消。重试 = 原输入再发（input 不因提交清空）。
import { useEffect, useRef, useState } from "react";
import { useDelayedUnmount } from "../ui/useDelayedUnmount";
import { useEscClose } from "../ui/useEscClose";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../session/SessionStore";
import { captureAiTarget, isTerminalSession } from "../session/aiTarget";
import { lastCwd } from "../terminal/CwdTracker";
import { CodeBlockRow, defaultInserter, type InsertTarget, type TerminalInserter } from "./InsertRow";
import { useNlStore, type NlRound } from "./nl2cmd";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useTerminalFocus } from "../terminal/terminalFocus";
import { activeProvider, loadAiSettings } from "./settings";
import { focusedPaneIdOf } from "./aiTargets";

/** 聚焦 pane 解析（App handleAction 与面板共用；与 insertToFocusedPane 同口径）。
 *  Task 3 起实现收口 aiTargets.focusedPaneIdOf——此处保留原导出为兼容面。 */
export function focusedSessionId(s: Pick<
  ReturnType<typeof useSessionStore.getState>,
  "activeId" | "activePane"
>): string | null {
  return focusedPaneIdOf(s);
}

/**
 * ⌘J 打开时的上下文锚点：聚焦 pane 的 OSC7 cwd 活值（无记录 → null）、
 * 聚焦会话的主机 id（取主机「备注」注入 AI 上下文；本地终端 → null）与
 * 不可变目标定格（Task 3——生成与插入都绑定它；无活终端 → null）。
 */
export function nlBegin(): void {
  const s = useSessionStore.getState();
  const focused = focusedPaneIdOf(s);
  const session = focused != null ? s.sessions.find((x) => x.id === focused) : undefined;
  let target: ReturnType<typeof captureAiTarget> | null = null;
  if (session && session.rustId != null && isTerminalSession(session)) {
    try {
      target = captureAiTarget(session);
    } catch {
      target = null; // 无 rustId 等防御路径（isTerminalSession 已滤主要面）
    }
  }
  useNlStore.getState().begin(
    focused != null ? lastCwd(focused) : null,
    session?.hostId ?? null,
    target,
  );
}

/** 轮次 → 插入绑定（有目标 + scope 才授权；否则 null = 禁插）。 */
function roundInsertTarget(round: Pick<NlRound, "target" | "scopeId" | "runId">): InsertTarget | null {
  return round.target && round.scopeId
    ? { target: round.target, scopeId: round.scopeId, runId: round.runId, blockIndex: 0 }
    : null;
}

export function NLCommandPanel({
  open,
  onClose,
  onOpenSettings,
  inserter = defaultInserter,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  inserter?: TerminalInserter;
}) {
  const { t } = useTranslation();
  const input = useNlStore((s) => s.input);
  const status = useNlStore((s) => s.status);
  const answer = useNlStore((s) => s.answer);
  const command = useNlStore((s) => s.command);
  const errorKind = useNlStore((s) => s.errorKind);
  const error = useNlStore((s) => s.error);
  const rounds = useNlStore((s) => s.rounds);
  const usage = useNlStore((s) => s.usage);
  const modelUsed = useNlStore((s) => s.modelUsed);
  const elapsedMs = useNlStore((s) => s.elapsedMs);
  const settingsUsed = useNlStore((s) => s.settingsUsed);
  const currentTarget = useNlStore((s) => s.target);
  const currentScopeId = useNlStore((s) => s.scopeId);
  const currentRunId = useNlStore((s) => s.runId);
  const setInput = useNlStore((s) => s.setInput);
  const submit = useNlStore((s) => s.submit);
  const abort = useNlStore((s) => s.abort);
  const close = useNlStore((s) => s.close);
  // 插入目标：轮次自己的来源绑定（Task 3）——聚焦 pane 仅用于「原终端」
  // 标注（原语选择器，焦点变化即重渲染）。
  const focusedId = useSessionStore(focusedSessionId);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时聚焦（等首帧渲染完，overlay 挂载后 input 才存在）。
  // 插入成功（2026-10-16 用户反馈）：切回终端视图 + 焦点交还 xterm + 收起
  // 面板——插入即进入执行姿态，不用再点一下；最近生成留在 store 可复看。
  // 定向焦点请求（Task 3）：指名来源 pane 的终端响应；插入只在聚焦 = 来源时
  // 可达，用户若在完成回调前已切走，订阅面不抢焦点。
  const onInsertedFor = (round: { target: InsertTarget["target"] | null }) => () => {
    useWorkspaceStore.getState().openMainView("terminal");
    useTerminalFocus.getState().request(round.target?.paneSessionId);
    onClose();
  };
  const onInserted = onInsertedFor({ target: currentTarget });

  // 打开即落焦（2026-10-18 用户反馈：呼出后光标不在输入框）。queueMicrotask
  // 的一次性 focus() 在 WKWebView 会被吞（⌘K 面板 2026-10-13 同坑同修）——
  // rAF 连帧重试，命中 activeElement 即停（至多 10 帧，正常 1-2 帧内命中）。
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let tries = 0;
    const tick = () => {
      if (document.activeElement === inputRef.current) return;
      inputRef.current?.focus();
      tries += 1;
      if (tries < 10) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 无可用 provider 前置检查（2026-10-16 用户需求②）：打开即查（未配置或
  // 全部禁用都算无可用）——不等输入提交失败才提示。读取失败按「有可用」
  // 处理（fail-open 到既有错误面，前置提示不做第二道卡）。设置页保存后
  // 重开面板（modal 单槽互斥）自然重查。
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProviderReady(null);
    void loadAiSettings()
      .then((s) => {
        if (!cancelled) setProviderReady(activeProvider(s.providers) !== null);
      })
      .catch(() => {
        if (!cancelled) setProviderReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 退场动画窗（评审 P1-8）：open=false 后保留挂载播镜像动画，再真卸载。
  const mount = useDelayedUnmount(open);
  // Esc 关闭走全局栈（语义 = handleClose：在途请求 abort + 清场 + 关）。
  useEscClose(open, handleClose);
  if (!mount.shouldRender) return null;
  const running = status === "running";
  const canRun = input.trim() !== "" && !running;

  /** 关闭 = 清场（在途请求一并 abort）+ 上抛开关。 */
  function handleClose() {
    close();
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (canRun) void submit();
    }
  }

  return (
    <div
      className={`palette-overlay nl2cmd-overlay${mount.closing ? " closing" : ""}`}
      onMouseDown={handleClose}
      data-testid="nl2cmd-panel"
    >
      <div
        className="palette nl2cmd"
        role="dialog"
        aria-modal="true"
        aria-label={t("ai.nl2cmd.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 无聚焦终端（2026-10-18 用户问询「插入到哪了」）：前置一句人话解释
            ——插入钮禁用的原因与去处；生成/复制不受影响。Task 3 起判据 =
            本轮来源绑定（target 为 null = 无活终端可绑定）。 */}
        {currentTarget === null && providerReady !== false && (
          <p className="settings-hint" data-testid="nl2cmd-noterminal" role="status">
            {t("ai.nl2cmd.noTerminal")}
          </p>
        )}
        {providerReady === false ? (
          // 无可用 provider：输入条让位，直接给提示 + 去设置引导
          // （2026-10-16 用户需求②——不逼用户先打一段字再撞错误）。
          <div className="ai-error" data-testid="nl2cmd-noprovider" role="alert">
            <p>{t("ai.errNoProvider")}</p>
            <button className="btn-accent" data-testid="nl2cmd-open-settings" onClick={onOpenSettings}>
              {t("ai.openSettings")}
            </button>
          </div>
        ) : (
          <div className="nl-input-row">
            <input
              ref={inputRef}
              className="palette-input"
              value={input}
              placeholder={t("ai.nl2cmd.placeholder")}
              aria-label={t("ai.nl2cmd.title")}
              data-testid="nl2cmd-input"
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
            />
            {running ? (
              <button className="ai-stop" data-testid="nl2cmd-stop" onClick={abort}>
                {t("ai.stop")}
              </button>
            ) : (
              <button
                className="btn-accent"
                data-testid="nl2cmd-run"
                disabled={!canRun}
                onClick={() => void submit()}
              >
                {t("ai.nl2cmd.run")}
              </button>
            )}
          </div>
        )}

        {running && answer === "" && (
          <p className="ai-thinking" data-testid="nl2cmd-thinking">
            {t("ai.nl2cmd.thinking")}
          </p>
        )}
        {running && answer !== "" && (
          <pre className="nl2cmd-stream" data-testid="nl2cmd-stream">
            {answer}
          </pre>
        )}

        {/* done：去展示包裹后的命令（多行/控制字符由公共插入入口拒绝）——danger
            徽标 + 三档确认插终端（公共 InsertRow，scope 绑定通道）。 */}
        {status === "done" && command !== null && (
          <div className="nl2cmd-result">
            <CodeBlockRow
              code={command}
              rustId={null}
              inserter={inserter}
              insertTarget={
                currentTarget && currentScopeId && currentRunId
                  ? { target: currentTarget, scopeId: currentScopeId, runId: currentRunId, blockIndex: 0 }
                  : null
              }
              onInserted={onInserted}
            />
          </div>
        )}

        {/* 往轮回看（批次三 T2，审计 ⌘J「生成结果无历史」）：rounds 随 close/begin
            保留（面板生命周期 = 会话级）；done 态主结果区即最新轮，跳过首位防重复。
            每条复用公共 InsertRow——**插入绑定 = 轮次自己的来源**（Task 3）：
            来源 pane ≠ 当前聚焦 pane → 组件守卫禁插 + 「原终端」标注。 */}
        {(() => {
          const prior = status === "done" ? rounds.slice(1) : rounds;
          if (prior.length === 0) return null;
          return (
            <div className="nl-history" data-testid="nl2cmd-history">
              <p className="nl-history-title">{t("ai.nl2cmd.history")}</p>
              <ul className="nl-history-list">
                {prior.map((r, i) => {
                  const binding = roundInsertTarget(r);
                  const fromOtherPane = r.target != null && r.target.paneSessionId !== focusedId;
                  return (
                    <li key={`${r.ts}-${i}`} className="nl-history-item" data-testid="nl2cmd-history-item">
                      <span className="nl-history-input" title={r.input}>
                        {r.input}
                        {fromOtherPane && (
                          <span
                            className="nl-history-origin"
                            data-testid={`nl2cmd-history-origin-${i}`}
                          >
                            {t("ai.insertWrongTarget")}
                          </span>
                        )}
                      </span>
                      <CodeBlockRow
                        code={r.command}
                        rustId={null}
                        inserter={inserter}
                        insertTarget={binding}
                        onInserted={onInsertedFor(r)}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })()}

        {/* 用量透明化（2026-11-02 批次一 B 项）：模型 · token · 耗时。
            端点不回 usage 时只显示模型与耗时（降级，不留空）。 */}
        {(status === "done" || status === "aborted") && (
          <div className="ai-usage-row" data-testid="nl2cmd-usage">
            <span className="ai-usage-model">
              {modelUsed ?? settingsUsed?.providers?.[0]?.model ?? ""}
            </span>
            {usage && (
              <span className="ai-usage-tokens" data-testid="nl2cmd-usage-tokens">
                {t("ai.usageTokens", {
                  input: usage.inputTokens,
                  output: usage.outputTokens,
                })}
              </span>
            )}
            {elapsedMs !== null && (
              <span className="ai-usage-elapsed" data-testid="nl2cmd-usage-elapsed">
                {t("ai.usageElapsed", { ms: elapsedMs })}
              </span>
            )}
          </div>
        )}

        {status === "aborted" && (
          <p className="ai-aborted" data-testid="nl2cmd-aborted">
            {t("ai.aborted")}
          </p>
        )}

        {status === "error" && (
          <div className="ai-error" data-testid="nl2cmd-error" role="alert">
            {(errorKind === "noProvider" || errorKind === "noKey") && (
              <>
                <p>{errorKind === "noProvider" ? t("ai.errNoProvider") : t("ai.errNoKey")}</p>
                <button className="btn-accent" data-testid="nl2cmd-open-settings" onClick={onOpenSettings}>
                  {t("ai.openSettings")}
                </button>
              </>
            )}
            {errorKind === "request" && (
              <>
                <p data-testid="nl2cmd-error-message">{error ?? t("ai.failed")}</p>
                <button className="btn-accent" data-testid="nl2cmd-retry" onClick={() => void submit()}>
                  {t("ai.retry")}
                </button>
              </>
            )}
            {errorKind === "empty" && (
              <>
                <p data-testid="nl2cmd-empty-message">{t("ai.nl2cmd.emptyAnswer")}</p>
                <button className="btn-accent" data-testid="nl2cmd-retry" onClick={() => void submit()}>
                  {t("ai.retry")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
