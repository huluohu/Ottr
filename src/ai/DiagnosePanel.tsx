// DiagnosePanel（Task 13，核心卖点 UI）：侧栏流式「原因 / 修复命令」。
// * 诊断（exit_code≠0 自动开）与选中解释（右键）共用本面板；
// * 流式渲染：普通文本 + ``` 代码块两种块——代码块带「插入终端」按钮 =
//   danger 分级标注（classify）+ 分档确认（green 直插 / yellow 确认 /
//   red 二次确认红字），插入 = write_session 直写 PTY（不含换行，回车由用户）。
//   代码块行组件已抽为公共 InsertRow（Phase 2 B1：⌘J NL 命令条共用同一
//   危险确认状态机——安全面单一来源）；
// * 脱敏口径（fix 1/5 M-1 定案）：面板命令区显示**原文**（本地行为，明文不出
//   本机）；发送给模型的请求体**已脱敏**（aiStore.run 内 redact 后才装配
//   messages——见 aiStore 步骤 3），面板以「已脱敏 N 处」标注外发侧命中；
// * 错误面：noProvider/noKey → 「去设置」按钮（App 注入 openSettings）；
//   request → 端点错误原文 + 重试；abort → 停止按钮（AbortController）。
import { useTranslation } from "react-i18next";
import { useAiStore } from "./aiStore";
import { CodeBlockRow, defaultInserter, type TerminalInserter } from "./InsertRow";

/** 从 markdown 形态的回复中提取 ``` 围栏代码块（位置 + 内容），供插终端按钮。 */
export interface AnswerCodeBlock {
  code: string;
}

export function extractCodeBlocks(answer: string): AnswerCodeBlock[] {
  const blocks: AnswerCodeBlock[] = [];
  const re = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const code = m[1].replace(/\n$/, "");
    if (code.trim() !== "") blocks.push({ code });
  }
  return blocks;
}

/** 回复渲染：按围栏代码块切分（流式过程中未闭合的尾部代码块也即时呈现）。 */
export function AnswerView({ answer, rustId, inserter }: {
  answer: string;
  rustId: string | null;
  inserter: TerminalInserter;
}) {
  const parts: { kind: "text" | "code"; content: string }[] = [];
  const re = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    if (m.index > last) parts.push({ kind: "text", content: answer.slice(last, m.index) });
    parts.push({ kind: "code", content: m[1].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < answer.length) parts.push({ kind: "text", content: answer.slice(last) });

  return (
    <div className="ai-answer" data-testid="ai-answer">
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <p key={i} className="ai-answer-text">{p.content}</p>
        ) : (
          <CodeBlockRow key={i} code={p.content} rustId={rustId} inserter={inserter} />
        ),
      )}
    </div>
  );
}

export function DiagnosePanel({
  onOpenSettings,
  inserter = defaultInserter,
}: {
  onOpenSettings: () => void;
  inserter?: TerminalInserter;
}) {
  const { t } = useTranslation();
  const request = useAiStore((s) => s.request);
  const status = useAiStore((s) => s.status);
  const answer = useAiStore((s) => s.answer);
  const errorKind = useAiStore((s) => s.errorKind);
  const error = useAiStore((s) => s.error);
  const redactions = useAiStore((s) => s.redactions);
  const settingsUsed = useAiStore((s) => s.settingsUsed);
  const abort = useAiStore((s) => s.abort);
  const run = useAiStore((s) => s.run);
  const close = useAiStore((s) => s.close);

  if (!request) return null;
  const running = status === "running";

  return (
    <aside className="ai-panel" data-testid="ai-panel" aria-label={t("ai.title")}>
      <div className="ai-panel-head">
        <span className="ai-panel-title">
          {request.kind === "diagnose" ? t("ai.panelDiagnose") : t("ai.panelExplain")}
        </span>
        <span className="ai-panel-meta">
          {settingsUsed?.providers[0]?.name ?? ""}
          {settingsUsed?.providers[0]?.model ? ` · ${settingsUsed.providers[0].model}` : ""}
        </span>
        <button
          className="ai-panel-close"
          data-testid="ai-close"
          aria-label={t("common.close")}
          onClick={close}
        >
          ×
        </button>
      </div>

      {request.kind === "diagnose" && (
        <div className="ai-request" data-testid="ai-request">
          <span className="ai-exit-code" data-testid="ai-exit-code">
            {t("ai.exitCodeBadge", { code: request.exitCode ?? "?" })}
          </span>
          <pre className="ai-request-cmd" data-testid="ai-request-cmd">{request.command}</pre>
        </div>
      )}

      <div className="ai-status-row">
        {redactions.length > 0 && (
          <span className="ai-redactions" data-testid="ai-redactions">
            {t("ai.redacted", { count: redactions.reduce((n, r) => n + r.count, 0) })}
          </span>
        )}
        {running && (
          <button className="ai-stop" data-testid="ai-stop" onClick={abort}>
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
              <button className="btn-accent" data-testid="ai-retry" onClick={() => void run()}>
                {t("ai.retry")}
              </button>
            </>
          )}
        </div>
      )}

      {status === "running" && answer === "" && (
        <p className="ai-thinking" data-testid="ai-thinking">
          {t("ai.thinking")}
        </p>
      )}

      <AnswerView answer={answer} rustId={request.kind === "diagnose" ? request.rustId : null} inserter={inserter} />
    </aside>
  );
}
