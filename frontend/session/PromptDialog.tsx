// PromptDialog（2026-11-02 批次二）：keyboard-interactive 交互式认证提问。
//
// 服务器（TOTP / PAM 2FA 跳板机）一次下发若干条提问，客户端逐条作答。
// 提问形如「Password:」「Verification code:」——后者由 Ottr **自动算好**并在
// 输入框里预填（Rust 侧随事件下发 `suggestion`），用户点一下即可提交。
//
// 与 TOFU 确认框（HostKeyDialog）同构：模态唯一槽（`promptAsk`）、Esc = 放弃
// （放弃 = 空答案 → 服务端拒绝 → 认证失败，fail-closed）。
//
// ## 验证码会过期（真机 E2E 抓到的缺陷）
//
// TOTP 码 30 秒一换。弹窗开着不动，填进去的码很快就是**上一窗**的旧码，
// 提交给服务端直接被拒（服务端日志：answer=上一窗码 / expected=当前窗码）。
// 因此这里做三件事：
//
// 1. 显示剩余有效秒数（`suggestion_expires_in` + 挂钟，不累加，避免漂移）；
// 2. 到期后**自动换一个码**——但只在用户没手动改过输入框时才换（用户手输
//    的码是他的选择，不能被覆盖）；
// 3. 点提交时若码已过期，先换新码再提交（避免「差 0.5 秒过期」的竞态）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { DialogClose } from "../ui/DialogClose";
import { useEscClose } from "../ui/useEscClose";
import { useSessionStore } from "./SessionStore";

interface TotpCodePayload {
  code: string;
  remaining_seconds: number;
}

export function PromptDialog() {
  const { t } = useTranslation();
  const ask = useSessionStore((s) => s.promptAsk);
  const answerPrompt = useSessionStore((s) => s.answerPrompt);
  const [values, setValues] = useState<string[]>([]);
  /** 自动填入码的到期时刻（ms 挂钟）；null = 本轮没有自动填码。 */
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  /** 用户是否手动改过输入框——改过就不自动覆盖他。 */
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  /** 走秒针（500ms 足够显示精度，且到期判定不受 setInterval 漂移影响）。 */
  const [now, setNow] = useState(() => Date.now());

  /** 承载自动填码的提问下标（无则 -1）。 */
  const codeIndex = useMemo(
    () => (ask ? ask.prompts.findIndex((p) => p.suggestion != null) : -1),
    [ask],
  );

  // 换问询 → 重置输入；首个输入框获焦（用户直接敲）。
  useEffect(() => {
    if (!ask) return;
    setValues(ask.prompts.map((p) => p.suggestion ?? ""));
    setTouched(false);
    setBusy(false);
    const suggested = ask.prompts.find((p) => p.suggestion != null);
    setExpiresAt(
      suggested?.suggestion_expires_in != null
        ? Date.now() + suggested.suggestion_expires_in * 1000
        : null,
    );
    setNow(Date.now());
    const raf = requestAnimationFrame(() => firstRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [ask]);

  useEffect(() => {
    if (!ask) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [ask]);

  /** 剩余有效秒数（null = 不知道有效期）。 */
  const remain = useMemo(
    () => (expiresAt == null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000))),
    [expiresAt, now],
  );

  /** 重新算一个当前有效的码；成功返回新码，失败返回 null。 */
  const refreshCode = useCallback(async (): Promise<string | null> => {
    if (!ask || codeIndex < 0) return null;
    try {
      const res = await invoke<TotpCodePayload>("credential_totp_code", {
        credentialId: ask.credential_id,
      });
      setValues((prev) => {
        const next = [...prev];
        next[codeIndex] = res.code;
        return next;
      });
      setExpiresAt(Date.now() + res.remaining_seconds * 1000);
      setTouched(false);
      return res.code;
    } catch {
      // 算不出新码（比如凭据被删/种子坏了）→ 保留旧值，让用户手输。
      return null;
    }
  }, [ask, codeIndex]);

  // 到期自动换码——**仅当用户没手动改过**。
  useEffect(() => {
    if (remain !== 0 || touched || codeIndex < 0) return;
    void refreshCode();
  }, [remain, touched, codeIndex, refreshCode]);

  // Esc = 放弃作答（空答案 = 拒绝，Rust 侧按认证失败收尾）。
  useEscClose(ask != null, () => {
    void answerPrompt([]);
  });

  if (!ask) return null;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    let out = values;
    // 码已过期且用户没改过 → 先换新码再提交（否则必被服务端拒）。
    if (remain === 0 && !touched && codeIndex >= 0) {
      const fresh = await refreshCode();
      if (fresh != null) {
        out = [...values];
        out[codeIndex] = fresh;
      }
    }
    void answerPrompt(out);
  };

  const hasSuggestion = codeIndex >= 0;

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
                // 用户改了验证码型输入框 → 不再自动覆盖（尊重手输）。
                if (i === codeIndex) setTouched(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
        ))}
        {hasSuggestion && (
          <p className="settings-hint" data-testid="prompt-autofill-hint">
            {t("promptAsk.autoFilled")}
          </p>
        )}
        {hasSuggestion && (
          <div className="prompt-code-status" data-testid="prompt-code-status">
            <span
              className={remain === 0 ? "prompt-code-expired" : "prompt-code-countdown"}
              data-testid="prompt-code-countdown"
            >
              {remain === 0 ? t("promptAsk.codeExpired") : t("promptAsk.codeExpiresIn", { n: remain })}
            </span>
            <button
              type="button"
              className="prompt-code-refresh"
              data-testid="prompt-code-refresh"
              onClick={() => void refreshCode()}
            >
              {t("promptAsk.codeRefresh")}
            </button>
          </div>
        )}
        <div className="form-actions">
          <button type="button" data-testid="prompt-cancel" onClick={() => void answerPrompt([])}>
            {t("promptAsk.cancel")}
          </button>
          <button
            type="button"
            className="btn-accent"
            data-testid="prompt-submit"
            disabled={busy}
            onClick={() => void submit()}
          >
            {t("promptAsk.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
