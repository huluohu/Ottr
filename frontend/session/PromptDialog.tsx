// PromptDialog（2026-11-02 批次二）：keyboard-interactive 交互式认证提问。
//
// 服务器（TOTP / PAM 2FA 跳板机）一次下发若干条提问，客户端逐条作答。
// 提问形如「Password:」「Verification code:」——后者由 Ottr **自动算好**并在
// 输入框里预填（Rust 侧随事件下发 `suggestion`），用户点一下即可提交。
//
// 与 TOFU 确认框（HostKeyDialog）同构：模态唯一槽（`promptAsk`）、Esc = 放弃
// （放弃 = 空答案 → 服务端拒绝 → 认证失败，fail-closed）。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogClose } from "../ui/DialogClose";
import { useEscClose } from "../ui/useEscClose";
import { useSessionStore } from "./SessionStore";

export function PromptDialog() {
  const { t } = useTranslation();
  const ask = useSessionStore((s) => s.promptAsk);
  const answerPrompt = useSessionStore((s) => s.answerPrompt);
  const [values, setValues] = useState<string[]>([]);
  const firstRef = useRef<HTMLInputElement>(null);

  // 换问询 → 重置输入；首个输入框获焦（用户直接敲）。
  useEffect(() => {
    if (!ask) return;
    setValues(ask.prompts.map((p) => p.suggestion ?? ""));
    const raf = requestAnimationFrame(() => firstRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [ask]);

  // Esc = 放弃作答（空答案 = 拒绝，Rust 侧按认证失败收尾）。
  useEscClose(ask != null, () => {
    void answerPrompt([]);
  });

  if (!ask) return null;

  const submit = () => {
    void answerPrompt(values);
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("promptAsk.title")}>
      <div className="dialog prompt-dialog" data-testid="prompt-dialog">
        <div className="dialog-head">
          <h2>{t("promptAsk.title")}</h2>
          <DialogClose
            onClose={() => {
              void answerPrompt([]);
            }}
            testid="prompt-dialog-close"
          />
        </div>
        <p className="dialog-intro">
          {ask.host_name}
          {ask.hop != null ? ` · ${t("promptAsk.hop", { n: ask.hop + 1 })}` : ""}
        </p>
        {ask.prompts.map((p, i) => (
          <label key={`${ask.ask_id}:${i}`} className="prompt-item">
            <span className="prompt-item-text">{p.text}</span>
            <input
              ref={i === 0 ? firstRef : undefined}
              type="password"
              autoComplete="off"
              spellCheck={false}
              data-testid={`prompt-input-${i}`}
              value={values[i] ?? ""}
              onChange={(e) => {
                const next = [...values];
                next[i] = e.target.value;
                setValues(next);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        ))}
        {ask.prompts.some((p) => p.suggestion != null) && (
          <p className="settings-hint" data-testid="prompt-autofill-hint">
            {t("promptAsk.autoFilled")}
          </p>
        )}
        <div className="form-actions">
          <button type="button" data-testid="prompt-cancel" onClick={() => void answerPrompt([])}>
            {t("promptAsk.cancel")}
          </button>
          <button
            type="button"
            className="btn-accent"
            data-testid="prompt-submit"
            onClick={submit}
          >
            {t("promptAsk.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
