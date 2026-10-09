// InsertRow（Phase 2 B1 从 DiagnosePanel 抽出）：AI 生成命令 → 插终端的公共
// 消费面。诊断面板（T13）与 ⌘J NL 命令条（B1）共用同一渲染与确认状态机——
// danger 分级徽标（classify）+ 分档确认（green 直插 / yellow 二击 / red armed
// 红字二击）+ write_session 直写 PTY（不含换行，回车由用户）。抽组件而非复制：
// 危险确认交互是安全面，两处实现必然漂移，单一来源是纪律。
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { classify, type TrafficLight } from "./danger";

/** 插入终端的写入面（测试注入点；生产 = write_session 直写 PTY）。 */
export type TerminalInserter = (rustId: string, text: string) => Promise<void>;

export function defaultInserter(rustId: string, text: string): Promise<void> {
  return invoke("write_session", { id: rustId, bytes: Array.from(new TextEncoder().encode(text)) });
}

/** 分档 → 按钮样式/文案的语义键。 */
function levelKey(level: TrafficLight): string {
  return level === "red" ? "ai.levelRed" : level === "yellow" ? "ai.levelYellow" : "ai.levelGreen";
}

/** 单条命令行（含 danger 分档与分级确认状态机）：
 * green 一键直插；yellow 第一击只切确认文案；red 两击（第二次红字 armed）。
 * 点别处不复位（面板内短路径，简单为上——T13 语义原样）。 */
export function CodeBlockRow({
  code,
  rustId,
  inserter,
}: {
  code: string;
  rustId: string | null;
  inserter: TerminalInserter;
}) {
  const { t } = useTranslation();
  const verdict = useMemo(() => classify(code), [code]);
  // 确认状态机：null（未进入）→ "confirm"（yellow 一发/red 第一发）→ red 的 armed
  const [stage, setStage] = useState<"idle" | "confirm" | "armed" | "inserted" | "failed">("idle");

  function proceed() {
    if (!rustId) return;
    void inserter(rustId, code)
      .then(() => setStage("inserted"))
      .catch(() => setStage("failed"));
  }

  function onClick() {
    if (!rustId || stage === "inserted") return;
    if (verdict.level === "green") {
      proceed();
      return;
    }
    if (verdict.level === "yellow") {
      if (stage === "confirm") {
        proceed();
      } else {
        setStage("confirm");
      }
      return;
    }
    // red：两次点击（第二次红字），点别处不复位（面板内短路径，简单为上）
    if (stage === "armed") {
      proceed();
    } else {
      setStage("armed");
    }
  }

  const label =
    stage === "inserted"
      ? t("ai.inserted")
      : stage === "armed"
        ? t("ai.insertConfirmRed")
        : stage === "confirm"
          ? t("ai.insertConfirm")
          : stage === "failed"
            ? t("ai.insertFailed")
            : t("ai.insertToTerminal");

  return (
    <div className="ai-codeblock" data-level={verdict.level} data-testid="ai-codeblock">
      <div className="ai-codeblock-head">
        <span className={`ai-level ai-level-${verdict.level}`} data-testid="ai-code-level">
          {t(levelKey(verdict.level))}
        </span>
        {verdict.findings.length > 0 && (
          <span className="ai-code-findings">
            {verdict.findings.map((f, i) => (
              <span key={`${f.kind}-${i}`} className="ai-code-finding">
                {t(`ai.danger.${f.kind}`, { defaultValue: f.kind })}
              </span>
            ))}
          </span>
        )}
        <button
          className={`ai-insert-btn${stage === "armed" ? " armed" : ""}`}
          data-testid="ai-insert"
          data-stage={stage}
          disabled={!rustId || stage === "inserted"}
          onClick={onClick}
        >
          {label}
        </button>
      </div>
      <pre className="ai-codeblock-code" data-testid="ai-code-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}
