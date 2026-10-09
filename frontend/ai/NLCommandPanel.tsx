// NLCommandPanel（Phase 2 B1，⌘J）：底部自然语言 → 命令输入条。
// * 交互骨架复用 palette/history 的 overlay 范式（Esc 关、点遮罩关、开时聚焦），
//   锚定改为**底部**（输入条语义：视线不离开终端下沿）；
// * 运行链在 useNlStore（nl2cmd.ts）：流式原文等宽渲染（生成中的命令成形过程
//   可见）→ done 后 sanitize 出单条命令 → 复用公共 InsertRow 渲染 danger 徽标
//   + 三档确认插终端（与诊断面板同一状态机——安全面单一来源）；
// * 插入目标 = 当前聚焦 pane（SessionStore activePane 解析，与
//   insertToFocusedPane 同口径）：无连接终端 → 插入按钮禁用（不静默失败）；
// * 错误面：noProvider/noKey → 「去设置」；request → 端点消息 + 重试；
//   empty（sanitize 不可用，如 stop 截在围栏头）→ 说明 + 重试；
//   aborted → 已取消。重试 = 原输入再发（input 不因提交清空）。
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../session/SessionStore";
import { lastCwd } from "../terminal/CwdTracker";
import { CodeBlockRow, defaultInserter, type TerminalInserter } from "./InsertRow";
import { useNlStore } from "./nl2cmd";

/** 聚焦 pane 解析（App handleAction 与面板共用；与 insertToFocusedPane 同口径）。 */
export function focusedSessionId(s: Pick<
  ReturnType<typeof useSessionStore.getState>,
  "activeId" | "activePane"
>): string | null {
  return s.activeId != null ? (s.activePane[s.activeId] ?? s.activeId) : null;
}

/** ⌘J 打开时的上下文锚点：聚焦 pane 的 OSC7 cwd 活值（无记录 → null）。 */
export function nlBegin(): void {
  const s = useSessionStore.getState();
  const focused = focusedSessionId(s);
  useNlStore.getState().begin(focused != null ? lastCwd(focused) : null);
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
  const setInput = useNlStore((s) => s.setInput);
  const submit = useNlStore((s) => s.submit);
  const abort = useNlStore((s) => s.abort);
  const close = useNlStore((s) => s.close);
  // 插入目标：当前聚焦 pane 的 rustId（原语选择器，焦点变化即重渲染）
  const focusedId = useSessionStore(focusedSessionId);
  const rustId = useSessionStore((s) =>
    focusedId != null ? (s.sessions.find((x) => x.id === focusedId)?.rustId ?? null) : null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时聚焦（等首帧渲染完，overlay 挂载后 input 才存在）。
  useEffect(() => {
    if (open) queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  if (!open) return null;
  const running = status === "running";
  const canRun = input.trim() !== "" && !running;

  /** 关闭 = 清场（在途请求一并 abort）+ 上抛开关。 */
  function handleClose() {
    close();
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (canRun) void submit();
    }
  }

  return (
    <div className="palette-overlay nl2cmd-overlay" onMouseDown={handleClose} data-testid="nl2cmd-panel">
      <div
        className="palette nl2cmd"
        role="dialog"
        aria-modal="true"
        aria-label={t("ai.nl2cmd.title")}
        onMouseDown={(e) => e.stopPropagation()}
      >
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

        {/* done：sanitize 后的单条命令——danger 徽标 + 三档确认插终端（公共 InsertRow） */}
        {status === "done" && command !== null && (
          <div className="nl2cmd-result">
            <CodeBlockRow code={command} rustId={rustId} inserter={inserter} />
          </div>
        )}

        {/* 往轮回看（批次三 T2，审计 ⌘J「生成结果无历史」）：rounds 随 close/begin
            保留（面板生命周期 = 会话级）；done 态主结果区即最新轮，跳过首位防重复。
            每条复用公共 InsertRow——往轮命令同样可（分档确认）插终端。 */}
        {(() => {
          const prior = status === "done" ? rounds.slice(1) : rounds;
          if (prior.length === 0) return null;
          return (
            <div className="nl-history" data-testid="nl2cmd-history">
              <p className="nl-history-title">{t("ai.nl2cmd.history")}</p>
              <ul className="nl-history-list">
                {prior.map((r, i) => (
                  <li key={`${r.ts}-${i}`} className="nl-history-item" data-testid="nl2cmd-history-item">
                    <span className="nl-history-input" title={r.input}>
                      {r.input}
                    </span>
                    <CodeBlockRow code={r.command} rustId={rustId} inserter={inserter} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

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
