// InsertRow（Phase 2 B1 从 DiagnosePanel 抽出）：AI 生成命令 → 插终端的公共
// 消费面。诊断面板（T13）与 ⌘J NL 命令条（B1）共用同一渲染与确认状态机——
// danger 分级徽标（classify）+ 分档确认（green 直插 / yellow 二击 / red armed
// 红字二击）+ 写 PTY 不含换行（回车由用户）。抽组件而非复制：危险确认交互
// 是安全面，两处实现必然漂移，单一来源是纪律。
//
// **插入通道（ask-ottr-orb Task 3）**：
// * scope 通道（默认走这里）：run 打开的 scope（scopeId + runId）+ 代码块序号
//   组成一次性 actionId（`${runId}:${blockIndex}`）→ `ai_scope_insert`——
//   后端 claim-before-await + 单行/无换行/锁定校验，绝不追加执行字节；
// * legacy 通道（insertTarget 缺省）：rustId + write_session 直写（存量测试面
//   与无绑定目标的旧路径，语义不变）。
// * **跨目标守卫在组件内**（注入的测试插入器绕不过）：当前聚焦 pane ≠ 绑定
//   pane → 插入禁用 + 「回到原终端」affordance——生成于哪个终端就只能插回
//   哪个终端，绝不静默改插当前聚焦终端。
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { classify, type TrafficLight } from "./danger";
import { aiSessionApi, type AiScopeTarget } from "./sessionApi";
import { focusedPaneIdOf, focusOriginalPane } from "./aiTargets";
import { useSessionStore } from "../session/SessionStore";

/** 插入终端的写入面（测试注入点；生产 = write_session 直写 PTY）。 */
export type TerminalInserter = (rustId: string, text: string) => Promise<void>;

/** 一次插入的 scope 绑定（run 授权面；随生成它的轮次落库）。 */
export interface InsertTarget {
  /** 绑定的不可变终端目标（生成时的聚焦 pane）。 */
  target: AiScopeTarget;
  /** 产出该块的 run 打开的 scope id。 */
  scopeId: string;
  /** 产出该块的 run id（actionId 前缀）。 */
  runId: string;
  /** 代码块在回答中的序号（actionId = `${runId}:${blockIndex}`）。 */
  blockIndex: number;
}

/** scope 通道写入面（测试注入点；生产 = ai_scope_insert）。 */
export type ScopeInserter = (target: InsertTarget, text: string) => Promise<void>;

// Reject terminal input controls independently of danger classification. Never flatten
// multiline shell syntax or rely on bracketed-paste support in the remote program.
export function canInsertCommand(text: string): boolean {
  return text.trim() !== "" && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text);
}

export async function defaultInserter(rustId: string, text: string): Promise<void> {
  if (!canInsertCommand(text)) throw new Error("Unsafe terminal insertion");
  return invoke("write_session", { id: rustId, bytes: Array.from(new TextEncoder().encode(text)) });
}

/** scope 通道生产插入器：单行守卫同一套 + 一次性 actionId（后端 claim-once，
 *  双击/重放由后端账本兜底）。 */
export async function defaultScopeInserter(t: InsertTarget, text: string): Promise<void> {
  if (!canInsertCommand(text)) throw new Error("Unsafe terminal insertion");
  return aiSessionApi.insert(t.scopeId, `${t.runId}:${t.blockIndex}`, text);
}

/** 分档 → 按钮样式/文案的语义键。 */
function levelKey(level: TrafficLight): string {
  return level === "red" ? "ai.levelRed" : level === "yellow" ? "ai.levelYellow" : "ai.levelGreen";
}

/** 单条命令行（含 danger 分档与分级确认状态机）：
 * green 一键直插；yellow 第一击只切确认文案；red 两击（第二次红字 armed）。
 * 点别处不复位（面板内短路径，简单为上——T13 语义原样）。
 * 确认状态属于「文本 + 绑定」：代码/scope/绑定 pane 任一变化 → remount 复位
 * （流式更新与焦点切换都不会带着旧确认落入新目标）。 */
export function CodeBlockRow(props: {
  code: string;
  rustId: string | null;
  inserter: TerminalInserter;
  /** scope 绑定（在位 = scope 通道；缺省 = legacy rustId 通道）。 */
  insertTarget?: InsertTarget | null;
  scopeInserter?: ScopeInserter;
  disabled?: boolean;
  /** 插入成功后的回调（2026-10-16 用户反馈：插完焦点没回终端还得再点一下
   *  才能执行）——消费方在此切回终端视图并请求 xterm 聚焦。 */
  onInserted?: () => void;
}) {
  const bindKey = props.insertTarget
    ? [
        props.insertTarget.target.paneSessionId,
        props.insertTarget.target.connectionEpoch,
        props.insertTarget.scopeId,
        props.insertTarget.runId,
        props.insertTarget.blockIndex,
      ]
    : [];
  // A confirmation belongs to exactly this text and destination, including streaming
  // updates and focus changes. Remount also isolates in-flight completion callbacks.
  return (
    <InsertRow
      key={JSON.stringify([props.code, props.rustId, props.disabled, ...bindKey])}
      {...props}
    />
  );
}

function InsertRow({
  code,
  rustId,
  inserter,
  insertTarget = null,
  scopeInserter = defaultScopeInserter,
  disabled = false,
  onInserted,
}: {
  code: string;
  rustId: string | null;
  inserter: TerminalInserter;
  insertTarget?: InsertTarget | null;
  scopeInserter?: ScopeInserter;
  disabled?: boolean;
  onInserted?: () => void;
}) {
  const { t } = useTranslation();
  const insertable = canInsertCommand(code);
  const verdict = useMemo(() => classify(code), [code]);
  // 确认状态机：null（未进入）→ "confirm"（yellow 一发/red 第一发）→ red 的 armed
  const [stage, setStage] = useState<"idle" | "confirm" | "armed" | "inserted" | "failed">("idle");
  // 聚焦 pane 订阅（原语选择器——焦点漂移即重渲染）：跨目标守卫在组件内
  // 判定，注入的插入器无法绕过。
  const focusedPane = useSessionStore(focusedPaneIdOf);
  const scopeMode = insertTarget != null;
  const wrongTarget = scopeMode && focusedPane !== insertTarget.target.paneSessionId;
  const blocked =
    !insertable || disabled || (scopeMode ? wrongTarget : !rustId);

  function proceed() {
    if (blocked || stage === "inserted") return;
    const run = scopeMode
      ? scopeInserter(insertTarget, code)
      : rustId
        ? inserter(rustId, code)
        : Promise.reject(new Error("insert: no bound terminal"));
    void run
      .then(() => {
        setStage("inserted");
        onInserted?.();
      })
      .catch(() => setStage("failed"));
  }

  function onClick() {
    if (blocked || stage === "inserted") return;
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
          disabled={blocked || stage === "inserted"}
          onClick={onClick}
        >
          {label}
        </button>
      </div>
      {(!insertable || disabled) && (
        <p className="settings-hint" data-testid="ai-insert-blocked" role="status">
          {t(!insertable ? "ai.insertBlocked" : "ai.insertIncomplete")}
        </p>
      )}
      {wrongTarget && insertTarget && (
        // 跨目标守卫（Task 3）：生成于原终端的结果，聚焦已漂走 → 禁插 +
        // 「回到原终端」affordance——绝不静默改插当前聚焦终端。
        <p className="settings-hint" data-testid="ai-insert-wrong-target" role="status">
          {t("ai.insertWrongTarget")}
          {" · "}
          {t("ai.insertWrongTargetHint")}
          <button
            type="button"
            className="ai-return-original"
            data-testid="ai-return-to-original"
            onClick={() => focusOriginalPane(insertTarget.target)}
          >
            {t("ai.returnToOriginal")}
          </button>
        </p>
      )}
      <pre className="ai-codeblock-code" data-testid="ai-code-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}
