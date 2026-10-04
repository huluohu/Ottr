// AISettings（Task 13）：BYOK provider CRUD（name/kind/baseURL/model + apiKey
// 存 vault secrets 密封面）、「测试连接」（非流式一发）、脱敏配置（主机名开关
// + 自定义规则）、诊断自动触发开关与 token 上限。
// * apiKey 纪律：表单只在「新建/换 key」时出现明文输入框；编辑既有 provider
//   留空 = 保留现值（secrets 不动）；删除 provider 连带删 secrets（防孤儿密文）；
// * 自定义规则保存前 try new RegExp 预检（非法值显式报错不落库）；
// * 设置读写走 vault settings（明文 JSON）——与 SecuritySettings 同一对话框形态。
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi } from "../vault/api";
import { Switch } from "../ui/Switch";
import { createProvider, type ProviderMeta } from "./provider";
import type { RedactRule } from "./redact";
import {
  DEFAULT_MAX_TOKENS,
  apiKeySecretKey,
  loadAiSettings,
  saveAiEnabled,
  saveAiMaxTokens,
  saveProviders,
  saveRedaction,
  type RedactionConfig,
} from "./settings";

export interface AISettingsProps {
  open: boolean;
  onClose: () => void;
}

const MAX_TOKENS_LIMIT = 8192; // Rust AI_MAX_TOKENS_LIMIT 同口径（写入侧校验）

interface ProviderDraft {
  id: string;
  name: string;
  kind: ProviderMeta["kind"];
  baseURL: string;
  model: string;
  /** 空串 = 保留现值（编辑态）/ 未配置（新建态）。 */
  apiKey: string;
}

function emptyDraft(): ProviderDraft {
  return {
    id: `prov-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: "",
    kind: "openai-compatible",
    baseURL: "",
    model: "",
    apiKey: "",
  };
}

/** 预设候选（kind=DeepSeek/Ollama 皆为 openai-compatible，仅 baseURL 捷径）。 */
const BASE_URL_PRESETS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  ollama: "http://localhost:11434/v1",
  anthropic: "https://api.anthropic.com",
};

export function AISettings({ open, onClose }: AISettingsProps) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [redaction, setRedaction] = useState<RedactionConfig>({ hostname: true, custom: [] });
  const [enabled, setEnabled] = useState(true);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null); // 正在测试的 provider id
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; msg: string } | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      setDraft(null);
      setFormError(null);
      setTestResult(null);
      setTesting(null);
      return;
    }
    void (async () => {
      try {
        const s = await loadAiSettings();
        setProviders(s.providers);
        setRedaction(s.redaction);
        setEnabled(s.enabled);
        setMaxTokens(s.maxTokens);
      } catch {
        // 非 Tauri 环境 / 后端不可达：保持默认值（改动时报错）
      }
    })();
  }, [open]);

  if (!open) return null;

  async function persistProviders(next: ProviderMeta[]) {
    setProviders(next);
    try {
      await saveProviders(next);
    } catch (e) {
      setFormError(String(e));
    }
  }

  function validateDraft(d: ProviderDraft): string | null {
    if (d.name.trim() === "") return t("ai.settings.errName");
    if (d.baseURL.trim() === "") return t("ai.settings.errBaseUrl");
    if (!/^https?:\/\//.test(d.baseURL.trim())) return t("ai.settings.errBaseUrlFormat");
    if (d.model.trim() === "") return t("ai.settings.errModel");
    return null;
  }

  async function saveDraft(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const err = validateDraft(draft);
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    const meta: ProviderMeta = {
      id: draft.id,
      name: draft.name.trim(),
      kind: draft.kind,
      baseURL: draft.baseURL.trim(),
      model: draft.model.trim(),
    };
    try {
      if (draft.apiKey !== "") {
        await vaultApi.secrets.set(apiKeySecretKey(draft.id), draft.apiKey);
      } else {
        // 新建且未填 key：允许（Ollama 无鉴权），编辑留空 = 保留现值
        if (!(await vaultApi.secrets.contains(apiKeySecretKey(draft.id))) && draft.kind === "anthropic") {
          setFormError(t("ai.settings.errKeyRequired"));
          return;
        }
      }
    } catch (e2) {
      setFormError(String(e2));
      return;
    }
    const exists = providers.some((p) => p.id === draft.id);
    await persistProviders(exists ? providers.map((p) => (p.id === draft.id ? meta : p)) : [...providers, meta]);
    setDraft(null);
  }

  async function removeProvider(id: string) {
    const next = providers.filter((p) => p.id !== id);
    await persistProviders(next);
    try {
      await vaultApi.secrets.delete(apiKeySecretKey(id));
    } catch {
      // 密文不存在（本就无 key）忽略；锁定态删除失败下次重试
    }
    if (draft?.id === id) setDraft(null);
  }

  async function moveDefault(id: string) {
    // 「设为默认」= 移到首位（诊断链取列表首个）
    const target = providers.find((p) => p.id === id);
    if (!target) return;
    await persistProviders([target, ...providers.filter((p) => p.id !== id)]);
  }

  async function testConnection(meta: ProviderMeta) {
    setTesting(meta.id);
    setTestResult(null);
    try {
      const apiKey = (await vaultApi.secrets.get(apiKeySecretKey(meta.id))) ?? "";
      const text = await createProvider(meta, apiKey).testConnection();
      setTestResult({ id: meta.id, ok: true, msg: text.slice(0, 120) || t("ai.settings.testOkEmpty") });
    } catch (e) {
      setTestResult({ id: meta.id, ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(null);
    }
  }

  async function toggleHostname(on: boolean) {
    const next = { ...redaction, hostname: on };
    setRedaction(next);
    try {
      await saveRedaction(next);
    } catch (e) {
      setFormError(String(e));
    }
  }

  async function addCustomRule(name: string, pattern: string) {
    if (name.trim() === "" || pattern.trim() === "") {
      setFormError(t("ai.settings.errRuleIncomplete"));
      return;
    }
    try {
      new RegExp(pattern); // 预检（非法正则显式拒绝，不落库）
    } catch {
      setFormError(t("ai.settings.errRuleInvalid"));
      return;
    }
    setFormError(null);
    const rule: RedactRule = { name: name.trim(), pattern, enabled: true };
    const next = { ...redaction, custom: [...redaction.custom, rule] };
    setRedaction(next);
    try {
      await saveRedaction(next);
    } catch (e) {
      setFormError(String(e));
    }
  }

  async function removeCustomRule(index: number) {
    const next = { ...redaction, custom: redaction.custom.filter((_, i) => i !== index) };
    setRedaction(next);
    try {
      await saveRedaction(next);
    } catch (e) {
      setFormError(String(e));
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("ai.title")} data-testid="ai-settings">
      <div className="dialog settings-dialog ai-settings-dialog">
        <h2>{t("ai.settings.title")}</h2>

        {/* --- 通用 --- */}
        <section aria-label={t("ai.settings.general")} data-testid="ai-general-section">
          <h3>{t("ai.settings.general")}</h3>
          <label className="settings-row">
            <span className="settings-label">{t("ai.settings.autoDiagnose")}</span>
            <Switch
              testid="ai-enabled"
              checked={enabled}
              onChange={(e) => {
                const v = e.currentTarget.checked;
                setEnabled(v);
                void saveAiEnabled(v).catch((err) => setFormError(String(err)));
              }}
            />
          </label>
          <p className="settings-hint">{t("ai.settings.autoDiagnoseHint")}</p>
          <label className="settings-row">
            <span className="settings-label">{t("ai.settings.maxTokens")}</span>
            <input
              type="number"
              min={16}
              max={MAX_TOKENS_LIMIT}
              data-testid="ai-max-tokens"
              value={maxTokens}
              onChange={(e) => {
                const n = Math.min(MAX_TOKENS_LIMIT, Math.max(16, Number(e.currentTarget.value) || DEFAULT_MAX_TOKENS));
                setMaxTokens(n);
                void saveAiMaxTokens(n).catch((err) => setFormError(String(err)));
              }}
            />
          </label>
        </section>

        {/* --- Provider 列表 --- */}
        <section aria-label={t("ai.settings.providers")} data-testid="ai-providers-section">
          <h3>{t("ai.settings.providers")}</h3>
          <p className="settings-hint">{t("ai.settings.byokHint")}</p>
          {providers.length === 0 && !draft && (
            <p className="settings-hint" data-testid="ai-providers-empty">
              {t("ai.settings.noProviders")}
            </p>
          )}
          <ul className="ai-provider-list">
            {providers.map((p, idx) => (
              <li key={p.id} className="ai-provider-row" data-testid={`ai-provider-${p.id}`}>
                <span className="ai-provider-name">
                  {idx === 0 && <span className="ai-default-badge">{t("ai.settings.defaultBadge")}</span>}
                  {p.kind === "mock" && (
                    <span className="ai-mock-badge" data-testid={`ai-mock-badge-${p.id}`}>
                      {t("ai.settings.mockBadge")}
                    </span>
                  )}
                  {p.name}
                </span>
                <span className="ai-provider-meta">
                  {p.kind === "anthropic" ? "Anthropic" : p.kind === "mock" ? "Mock" : "OpenAI 兼容"} · {p.model}
                </span>
                <span className="ai-provider-actions">
                  {idx !== 0 && (
                    <button data-testid={`ai-provider-default-${p.id}`} onClick={() => void moveDefault(p.id)}>
                      {t("ai.settings.setDefault")}
                    </button>
                  )}
                  <button
                    data-testid={`ai-provider-test-${p.id}`}
                    disabled={testing !== null}
                    onClick={() => void testConnection(p)}
                  >
                    {testing === p.id ? t("ai.settings.testing") : t("ai.settings.test")}
                  </button>
                  <button
                    data-testid={`ai-provider-edit-${p.id}`}
                    onClick={() =>
                      setDraft({ id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL, model: p.model, apiKey: "" })
                    }
                  >
                    {t("common.edit")}
                  </button>
                  <button
                    className="danger"
                    data-testid={`ai-provider-delete-${p.id}`}
                    onClick={() => void removeProvider(p.id)}
                  >
                    {t("common.delete")}
                  </button>
                </span>
                {testResult?.id === p.id && (
                  <p
                    className={`settings-hint ${testResult.ok ? "ai-test-ok" : "form-error"}`}
                    data-testid={`ai-test-result-${p.id}`}
                  >
                    {testResult.ok ? "✓ " : "✗ "}
                    {testResult.msg}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {!draft && (
            <button className="btn-accent" data-testid="ai-add-provider" onClick={() => setDraft(emptyDraft())}>
              {t("ai.settings.addProvider")}
            </button>
          )}

          {draft && (
            <form className="wizard-step" onSubmit={(e) => void saveDraft(e)} noValidate data-testid="ai-provider-form">
              <p className="dialog-intro">{t("ai.settings.formTitle")}</p>
              <label>
                <span>{t("ai.settings.fieldName")}</span>
                <input
                  data-testid="ai-field-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
                />
              </label>
              <label>
                <span>{t("ai.settings.fieldKind")}</span>
                <select
                  data-testid="ai-field-kind"
                  value={draft.kind}
                  onChange={(e) => {
                    const kind = e.currentTarget.value as ProviderMeta["kind"];
                    // 预设 = 具体端点类型捷径；mock 刻意不自动填 baseURL
                    // （测试端点地址由使用者显式给，防误指真实端点）
                    const preset =
                      kind === "anthropic"
                        ? BASE_URL_PRESETS.anthropic
                        : kind === "mock"
                          ? ""
                          : BASE_URL_PRESETS.openai;
                    setDraft({ ...draft, kind, baseURL: draft.baseURL || preset });
                  }}
                >
                  <option value="openai-compatible">{t("ai.settings.kindOpenai")}</option>
                  <option value="anthropic">{t("ai.settings.kindAnthropic")}</option>
                  <option value="mock">{t("ai.settings.kindMock")}</option>
                </select>
              </label>
              <div className="ai-presets">
                {Object.entries(BASE_URL_PRESETS).map(([key, url]) => (
                  <button
                    key={key}
                    type="button"
                    className="ai-preset"
                    data-testid={`ai-preset-${key}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        kind: key === "anthropic" ? "anthropic" : "openai-compatible",
                        baseURL: url,
                      })
                    }
                  >
                    {key}
                  </button>
                ))}
              </div>
              <label>
                <span>{t("ai.settings.fieldBaseUrl")}</span>
                <input
                  data-testid="ai-field-baseurl"
                  value={draft.baseURL}
                  placeholder="https://api.deepseek.com"
                  onChange={(e) => setDraft({ ...draft, baseURL: e.currentTarget.value })}
                />
              </label>
              <label>
                <span>{t("ai.settings.fieldModel")}</span>
                <input
                  data-testid="ai-field-model"
                  value={draft.model}
                  placeholder="deepseek-chat"
                  onChange={(e) => setDraft({ ...draft, model: e.currentTarget.value })}
                />
              </label>
              <label>
                <span>{t("ai.settings.fieldApiKey")}</span>
                <input
                  type="password"
                  data-testid="ai-field-apikey"
                  value={draft.apiKey}
                  autoComplete="off"
                  placeholder={t("ai.settings.apiKeyPlaceholder")}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.currentTarget.value })}
                />
              </label>
              <p className="settings-hint">{t("ai.settings.apiKeyHint")}</p>
              {formError && (
                <p className="form-error" data-testid="ai-form-error">
                  {formError}
                </p>
              )}
              <div className="form-actions">
                <button type="button" data-testid="ai-form-cancel" onClick={() => setDraft(null)}>
                  {t("common.cancel")}
                </button>
                <button type="submit" className="btn-accent" data-testid="ai-form-save">
                  {t("common.save")}
                </button>
              </div>
            </form>
          )}
        </section>

        {/* --- 脱敏 --- */}
        <section aria-label={t("ai.settings.redaction")} data-testid="ai-redaction-section">
          <h3>{t("ai.settings.redaction")}</h3>
          <label className="settings-row">
            <span className="settings-label">{t("ai.settings.redactHostname")}</span>
            <Switch
              testid="ai-redact-hostname"
              checked={redaction.hostname}
              onChange={(e) => void toggleHostname(e.currentTarget.checked)}
            />
          </label>
          <p className="settings-hint">{t("ai.settings.redactionHint")}</p>
          <ul className="ai-rule-list">
            {redaction.custom.map((r, i) => (
              <li key={`${r.name}-${i}`} className="ai-rule-row" data-testid={`ai-rule-${i}`}>
                <code>{r.name}</code>
                <code className="ai-rule-pattern">{r.pattern}</code>
                <button data-testid={`ai-rule-delete-${i}`} onClick={() => void removeCustomRule(i)}>
                  {t("common.delete")}
                </button>
              </li>
            ))}
          </ul>
          <CustomRuleForm onAdd={(name, pattern) => void addCustomRule(name, pattern)} />
        </section>

        {formError && !draft && (
          <p className="form-error" data-testid="ai-settings-error">
            {formError}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn-accent" data-testid="ai-settings-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 自定义规则追加行（name + pattern；保存前预检在 addCustomRule）。 */
function CustomRuleForm({ onAdd }: { onAdd: (name: string, pattern: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  return (
    <div className="ai-rule-add">
      <input
        data-testid="ai-rule-name"
        value={name}
        placeholder={t("ai.settings.ruleName")}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <input
        data-testid="ai-rule-pattern"
        value={pattern}
        placeholder={t("ai.settings.rulePattern")}
        onChange={(e) => setPattern(e.currentTarget.value)}
      />
      <button
        data-testid="ai-rule-add"
        onClick={() => {
          onAdd(name, pattern);
          setName("");
          setPattern("");
        }}
      >
        {t("common.add")}
      </button>
    </div>
  );
}
