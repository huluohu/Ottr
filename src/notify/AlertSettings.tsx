// AlertSettings（Phase 3 Task 3，B5；UI 批次一 Task 4 迁右侧 dock）：告警设置
// 面板——渠道配置区 + 告警规则配置区（工具菜单 → dock/DockPanel 承载）。
// * 【T4 分区化】渠道/规则两分区以 SegmentedControl 独占切换（一次只挂载一
//   分区）：原对话框两节纵排 + 内嵌向导表单要滚过两屏（Phase 3 走查 13/14 号
//   截图问题），dock 内编辑表单改在所在分区内展开——双屏滚动消除。
// * 渠道：12 类（kind select → CHANNEL_FIELD_SPECS 渲染字段面；secret 字段
//   password 输入）。敏感纪律：编辑既有渠道时 reveal 预填真实值（单点出库），
//   **secret 字段留空 = 保存时回填原值**（不重输不覆盖）；保存/删除后
//   remountChannels() 重挂载（core.channels 挂载点）。「发送测试」真发一条
//   测试消息（testChannel；SMTP 经 Rust lettre，其余 TS fetch）。
// * 规则：主机下拉（vaultStore hosts）+ 类型（disk/cpu/process/log——log 为
//   Phase 4 T2 解禁：路径/关键字正则/采样间隔，路径白名单与 Rust 入口同规）
//   + 类型参数 + 订阅渠道多选 + rate_limit + mute_window。保存后 engine.reload()。
// * 表单校验在保存前（必填/数字/JSON 头与模板），错误行内显式报不落库。
// * 主题/i18n 纪律：样式走 App.css 令牌段；文案全走词典键。
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi, type AlertRule, type AlertRuleKind, type ChannelKind, type Host, type NotifyChannel } from "../vault/api";
import { useVaultStore } from "../vault/store";
import { engine } from "./rules";
import { remountChannels, testChannel } from "./channelRegistry";
import { Switch } from "../ui/Switch";
import { Checkbox } from "../ui/Checkbox";
import { SegmentedControl } from "../ui/SegmentedControl";
import {
  CHANNEL_FIELD_SPECS,
  CHANNEL_REQUIRED,
  renderTemplate,
} from "./channels/types";

export interface AlertSettingsProps {
  open: boolean;
  onClose: () => void;
}

const CHANNEL_KINDS: ChannelKind[] = [
  "dingtalk", "feishu", "wecom", "bark", "serverchan", "telegram",
  "discord", "slack", "smtp", "pushover", "ntfy", "webhook",
];

interface ChannelDraft {
  id: number | null;
  kind: ChannelKind;
  enabled: boolean;
  /** 表单原始输入（string 面；数字字段保存时转） */
  config: Record<string, string>;
  /** 编辑态 reveal 的原值（secret 留空回填；save 后清）。 */
  original: Record<string, unknown> | null;
}

interface RuleDraft {
  id: number | null;
  host_id: string;
  kind: AlertRuleKind;
  params: Record<string, string>;
  channels: number[];
  rate_limit: string;
  mute_window: string;
}

function emptyChannelDraft(): ChannelDraft {
  return { id: null, kind: "dingtalk", enabled: true, config: {}, original: null };
}

function emptyRuleDraft(): RuleDraft {
  return {
    id: null, host_id: "", kind: "disk",
    params: { mount: "/", threshold: "90", consecutive: "3", comm: "", path: "", pattern: "", interval: "10" },
    channels: [], rate_limit: "0", mute_window: "",
  };
}

/** 表单输入 → 明文 config（secret 留空回填原值；数字字段转换）。 */
function buildConfig(draft: ChannelDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of CHANNEL_FIELD_SPECS[draft.kind] ?? []) {
    const raw = (draft.config[field.key] ?? "").trim();
    if (raw === "") {
      if (field.secret && draft.original && draft.original[field.key] !== undefined) {
        out[field.key] = draft.original[field.key]; // 未重输不覆盖
      }
      continue;
    }
    out[field.key] = field.number ? Number(raw) : raw;
  }
  return out;
}

/** 参数行属性（kind 切换时共用一套 params 池，保存时按 kind 取面）。 */
function paramOf(params: Record<string, string>, key: string): string {
  return params[key] ?? "";
}

export function AlertSettings({ open, onClose }: AlertSettingsProps) {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);

  const [channels, setChannels] = useState<NotifyChannel[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  // T4 分区化：渠道/规则独占切换（默认渠道；规则编辑在规则分区内展开）。
  const [section, setSection] = useState<"channels" | "rules">("channels");
  const [channelDraft, setChannelDraft] = useState<ChannelDraft | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [testState, setTestState] = useState<{ id: number | "draft"; ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState<number | "draft" | null>(null);

  useEffect(() => {
    if (!open) {
      setChannelDraft(null);
      setRuleDraft(null);
      setFormError(null);
      setTestState(null);
      return;
    }
    void (async () => {
      try {
        setChannels(await vaultApi.notifyChannels.list());
      } catch {
        // 非 Tauri / 锁定：空列表（改动时报错）
      }
      try {
        setRules(await vaultApi.alertRules.list());
      } catch {
        // 同上
      }
    })();
  }, [open]);

  if (!open) return null;

  async function reloadChannels(): Promise<void> {
    setChannels(await vaultApi.notifyChannels.list());
    await remountChannels();
  }

  async function reloadRules(): Promise<void> {
    setRules(await vaultApi.alertRules.list());
    await engine.reload();
  }

  function validateChannel(d: ChannelDraft): string | null {
    for (const key of CHANNEL_REQUIRED[d.kind] ?? []) {
      const raw = (d.config[key] ?? "").trim();
      const isSecret = (CHANNEL_FIELD_SPECS[d.kind] ?? []).some(
        (f) => f.key === key && f.secret,
      );
      if (raw === "" && !(isSecret && d.original?.[key] !== undefined)) {
        return t("alert.errFieldRequired");
      }
      if (d.kind === "smtp" && key === "port" && raw !== "" && !Number.isFinite(Number(raw))) {
        return t("alert.errFieldNumber");
      }
    }
    const headers = (d.config["headers"] ?? "").trim();
    if (headers !== "") {
      try {
        const parsed = JSON.parse(headers);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return t("alert.errHeadersInvalid");
        }
      } catch {
        return t("alert.errHeadersInvalid");
      }
    }
    const tpl = (d.config["body_template"] ?? "").trim();
    if (tpl !== "") {
      try {
        JSON.parse(renderTemplate(tpl, { host: "h", rule: "r", value: "v", severity: "warning", count: "0", title: "t", body: "b" }));
      } catch {
        return t("alert.errTemplateInvalid");
      }
    }
    return null;
  }

  async function saveChannel(e: FormEvent) {
    e.preventDefault();
    if (!channelDraft) return;
    const err = validateChannel(channelDraft);
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    const config = buildConfig(channelDraft);
    try {
      if (channelDraft.id === null) {
        await vaultApi.notifyChannels.create({
          kind: channelDraft.kind,
          config,
          template_overrides: null,
          enabled: channelDraft.enabled,
        });
      } else {
        await vaultApi.notifyChannels.update(channelDraft.id, {
          kind: channelDraft.kind,
          config,
          template_overrides: null,
          enabled: channelDraft.enabled,
        });
      }
      await reloadChannels();
      setChannelDraft(null);
    } catch (e2) {
      setFormError(`${t("alert.errSaveFailed")}: ${String(e2)}`);
    }
  }

  async function editChannel(row: NotifyChannel) {
    let config: Record<string, unknown> = {};
    try {
      config = await vaultApi.notifyChannels.revealConfig(row.id);
    } catch (e) {
      setTestState({ id: row.id, ok: false, msg: String(e) });
      return;
    }
    const draft = emptyChannelDraft();
    const configDraft: Record<string, string> = {};
    for (const field of CHANNEL_FIELD_SPECS[row.kind] ?? []) {
      const v = config[field.key];
      // secret 不回显（明文不回 UI——密码输入框惯例）；留空 = 保留现值
      configDraft[field.key] = field.secret ? "" : v === undefined || v === null ? "" : String(v);
    }
    setChannelDraft({
      ...draft,
      id: row.id,
      kind: row.kind,
      enabled: row.enabled,
      config: configDraft,
      original: config,
    });
    setFormError(null);
  }

  async function testRow(row: NotifyChannel) {
    setTesting(row.id);
    setTestState(null);
    try {
      const config = await vaultApi.notifyChannels.revealConfig(row.id);
      await testChannel(row.kind, config);
      setTestState({ id: row.id, ok: true, msg: t("alert.testOk") });
    } catch (e) {
      setTestState({ id: row.id, ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(null);
    }
  }

  async function testDraft() {
    if (!channelDraft) return;
    setTesting("draft");
    setTestState(null);
    try {
      await testChannel(channelDraft.kind, buildConfig(channelDraft));
      setTestState({ id: "draft", ok: true, msg: t("alert.testOk") });
    } catch (e) {
      setTestState({ id: "draft", ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(null);
    }
  }

  async function deleteChannel(id: number) {
    try {
      await vaultApi.notifyChannels.remove(id);
      await reloadChannels();
    } catch (e) {
      setFormError(String(e));
    }
  }

  function validateRule(d: RuleDraft): string | null {
    if (d.host_id === "") return t("alert.errNoHost");
    if (d.kind === "disk" && paramOf(d.params, "threshold").trim() === "") return t("alert.errFieldRequired");
    if (d.kind === "cpu" && (paramOf(d.params, "threshold").trim() === "" || paramOf(d.params, "consecutive").trim() === "")) {
      return t("alert.errFieldRequired");
    }
    if (d.kind === "process" && paramOf(d.params, "comm").trim() === "") return t("alert.errFieldRequired");
    if (d.kind === "log") {
      // 路径白名单与 Rust 入口同规（ottr_monitor::log_path_is_safe）——保存前
      // 挡第一道，错误行内可见；正则必须可编译（引擎侧非法正则静默跳过）。
      const path = paramOf(d.params, "path").trim();
      const pattern = paramOf(d.params, "pattern").trim();
      if (path === "" || pattern === "") return t("alert.errFieldRequired");
      if (!/^\/[A-Za-z0-9/._-]*$/.test(path)) return t("alert.errLogPathInvalid");
      try {
        new RegExp(pattern);
      } catch {
        return t("alert.errRegexInvalid");
      }
    }
    if (d.mute_window.trim() !== "" && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(d.mute_window.trim())) {
      return t("alert.errFieldRequired");
    }
    return null;
  }

  async function saveRule(e: FormEvent) {
    e.preventDefault();
    if (!ruleDraft) return;
    const err = validateRule(ruleDraft);
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    const interval = paramOf(ruleDraft.params, "interval").trim();
    const params: Record<string, unknown> =
      ruleDraft.kind === "disk"
        ? { mount: paramOf(ruleDraft.params, "mount").trim() || "/", threshold: Number(paramOf(ruleDraft.params, "threshold")) }
        : ruleDraft.kind === "cpu"
          ? { threshold: Number(paramOf(ruleDraft.params, "threshold")), consecutive: Math.max(1, Math.floor(Number(paramOf(ruleDraft.params, "consecutive")) || 1)) }
          : ruleDraft.kind === "process"
            ? { comm: paramOf(ruleDraft.params, "comm").trim() }
            : {
                path: paramOf(ruleDraft.params, "path").trim(),
                pattern: paramOf(ruleDraft.params, "pattern").trim(),
                interval_secs: Math.max(5, Math.floor(Number(interval) || 10)),
              };
    const input = {
      host_id: Number(ruleDraft.host_id),
      kind: ruleDraft.kind,
      params,
      channels: ruleDraft.channels,
      rate_limit: Math.max(0, Math.floor(Number(ruleDraft.rate_limit) || 0)),
      mute_window: ruleDraft.mute_window.trim() === "" ? null : ruleDraft.mute_window.trim(),
    };
    try {
      if (ruleDraft.id === null) {
        await vaultApi.alertRules.create(input);
      } else {
        await vaultApi.alertRules.update(ruleDraft.id, input);
      }
      await reloadRules();
      setRuleDraft(null);
    } catch (e2) {
      setFormError(`${t("alert.errSaveFailed")}: ${String(e2)}`);
    }
  }

  function editRule(row: AlertRule) {
    const p = row.params as Record<string, unknown>;
    setRuleDraft({
      id: row.id,
      host_id: String(row.host_id),
      kind: row.kind,
      params: {
        mount: String(p["mount"] ?? "/"),
        threshold: String(p["threshold"] ?? ""),
        consecutive: String(p["consecutive"] ?? "3"),
        comm: String(p["comm"] ?? ""),
        path: String(p["path"] ?? ""),
        pattern: String(p["pattern"] ?? ""),
        interval: String(p["interval_secs"] ?? "10"),
      },
      channels: [...row.channels],
      rate_limit: String(row.rate_limit),
      mute_window: row.mute_window ?? "",
    });
    setFormError(null);
  }

  async function deleteRule(id: number) {
    try {
      await vaultApi.alertRules.remove(id);
      await reloadRules();
    } catch (e) {
      setFormError(String(e));
    }
  }

  function toggleDraftChannel(id: number) {
    if (!ruleDraft) return;
    setRuleDraft({
      ...ruleDraft,
      channels: ruleDraft.channels.includes(id)
        ? ruleDraft.channels.filter((c) => c !== id)
        : [...ruleDraft.channels, id],
    });
  }

  function hostName(id: number): string {
    return hosts.find((h) => h.id === id)?.name ?? `#${id}`;
  }

  const kindOptions = (ks: ChannelKind[]) =>
    ks.map((k) => (
      <option key={k} value={k}>
        {t(`alert.kind.${k}`)}
      </option>
    ));

  return (
    // dock 内容形态（T4）：标题/关闭由 dock 壳供给（底部关闭钮保留）；
    // 渠道/规则分区独占切换（见头注分区化）。
    <div className="dock-entity settings-dialog" role="region" aria-label={t("alert.settingsTitle")} data-testid="alert-settings">
      <SegmentedControl
        testid="alert-section-switch"
        ariaLabel={t("alert.settingsTitle")}
        value={section}
        options={[
          { value: "channels", label: t("alert.channelSection") },
          { value: "rules", label: t("alert.ruleSection") },
        ]}
        onChange={setSection}
      />

      {section === "channels" && (
        <section aria-label={t("alert.channelSection")} data-testid="alert-channels-section">
          <h3>{t("alert.channelSection")}</h3>
          <p className="settings-hint">{t("alert.channelHint")}</p>
          {channels.length === 0 && !channelDraft && (
            <p className="settings-hint" data-testid="alert-channels-empty">
              {t("alert.noChannels")}
            </p>
          )}
          <ul className="ai-provider-list">
            {channels.map((c) => (
              <li key={c.id} className="ai-provider-row" data-testid={`alert-channel-${c.id}`}>
                <span className="ai-provider-name">
                  {!c.enabled && <span className="ai-default-badge">{t("common.no")}</span>}
                  {t(`alert.kind.${c.kind}`)}
                </span>
                <span className="ai-provider-actions">
                  <button
                    data-testid={`alert-channel-test-${c.id}`}
                    disabled={testing !== null}
                    onClick={() => void testRow(c)}
                  >
                    {testing === c.id ? t("alert.testing") : t("alert.test")}
                  </button>
                  <button data-testid={`alert-channel-edit-${c.id}`} onClick={() => void editChannel(c)}>
                    {t("common.edit")}
                  </button>
                  <button className="danger" data-testid={`alert-channel-delete-${c.id}`} onClick={() => void deleteChannel(c.id)}>
                    {t("common.delete")}
                  </button>
                </span>
                {testState?.id === c.id && (
                  <p className={`settings-hint ${testState.ok ? "ai-test-ok" : "form-error"}`} data-testid={`alert-channel-result-${c.id}`}>
                    {testState.ok ? "✓ " : "✗ "}
                    {testState.msg}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {!channelDraft && (
            <button className="btn-accent" data-testid="alert-add-channel" onClick={() => { setChannelDraft(emptyChannelDraft()); setTestState(null); }}>
              {t("alert.addChannel")}
            </button>
          )}

          {channelDraft && (
            <form className="wizard-step" onSubmit={(e) => void saveChannel(e)} noValidate data-testid="alert-channel-form">
              <p className="dialog-intro">{t("alert.channelFormTitle")}</p>
              <label>
                <span>{t("alert.fieldKind")}</span>
                <select
                  data-testid="alert-channel-kind"
                  value={channelDraft.kind}
                  onChange={(e) =>
                    setChannelDraft({ ...channelDraft, kind: e.currentTarget.value as ChannelKind, config: {}, original: null })
                  }
                >
                  {kindOptions(CHANNEL_KINDS)}
                </select>
              </label>
              {(CHANNEL_FIELD_SPECS[channelDraft.kind] ?? []).map((field) => (
                <label key={field.key}>
                  <span>{t(`alert.channelField.${field.labelKey}`)}</span>
                  {field.multiline ? (
                    <textarea
                      data-testid={`alert-field-${field.key}`}
                      rows={2}
                      placeholder={field.placeholder}
                      value={paramOf(channelDraft.config, field.key)}
                      onChange={(e) => setChannelDraft({ ...channelDraft, config: { ...channelDraft.config, [field.key]: e.currentTarget.value } })}
                    />
                  ) : (
                    <input
                      data-testid={`alert-field-${field.key}`}
                      type={field.secret ? "password" : field.number ? "number" : "text"}
                      autoComplete={field.secret ? "new-password" : "off"}
                      placeholder={field.placeholder}
                      value={paramOf(channelDraft.config, field.key)}
                      onChange={(e) => setChannelDraft({ ...channelDraft, config: { ...channelDraft.config, [field.key]: e.currentTarget.value } })}
                    />
                  )}
                </label>
              ))}
              <label className="settings-row">
                <span className="settings-label">{t("alert.fieldEnabled")}</span>
                <Switch
                  testid="alert-channel-enabled"
                  checked={channelDraft.enabled}
                  onChange={(e) => setChannelDraft({ ...channelDraft, enabled: e.currentTarget.checked })}
                />
              </label>
              <div className="form-actions">
                <button type="button" data-testid="alert-channel-test-draft" disabled={testing !== null} onClick={() => void testDraft()}>
                  {testing === "draft" ? t("alert.testing") : t("alert.test")}
                </button>
                <button type="button" data-testid="alert-channel-cancel" onClick={() => setChannelDraft(null)}>
                  {t("common.cancel")}
                </button>
                <button type="submit" className="btn-accent" data-testid="alert-channel-save">
                  {t("common.save")}
                </button>
              </div>
              {formError && (
                <p className="form-error" data-testid="alert-form-error">
                  {formError}
                </p>
              )}
              {testState?.id === "draft" && (
                <p className={`settings-hint ${testState.ok ? "ai-test-ok" : "form-error"}`} data-testid="alert-channel-result-draft">
                  {testState.ok ? "✓ " : "✗ "}
                  {testState.msg}
                </p>
              )}
            </form>
          )}
        </section>
      )}

      {/* --- 规则 --- */}
      {section === "rules" && (
        <section aria-label={t("alert.ruleSection")} data-testid="alert-rules-section">
          <h3>{t("alert.ruleSection")}</h3>
          <p className="settings-hint">{t("alert.ruleHint")}</p>
          {rules.length === 0 && !ruleDraft && (
            <p className="settings-hint" data-testid="alert-rules-empty">
              {t("alert.noRules")}
            </p>
          )}
          <ul className="ai-provider-list">
            {rules.map((r) => (
              <li key={r.id} className="ai-provider-row" data-testid={`alert-rule-${r.id}`}>
                <span className="ai-provider-name">
                  {hostName(r.host_id)} · {r.kind === "log" ? t("alert.kindLog") : t(`alert.title.${r.kind}`)}
                </span>
                <span className="ai-provider-meta">
                  {t("alert.lastFired")}: {r.last_fired ? new Date(r.last_fired * 1000).toLocaleString() : t("alert.never")}
                </span>
                <span className="ai-provider-actions">
                  <button data-testid={`alert-rule-edit-${r.id}`} onClick={() => editRule(r)}>
                    {t("common.edit")}
                  </button>
                  <button className="danger" data-testid={`alert-rule-delete-${r.id}`} onClick={() => void deleteRule(r.id)}>
                    {t("common.delete")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {!ruleDraft && (
            <button className="btn-accent" data-testid="alert-add-rule" onClick={() => { setRuleDraft(emptyRuleDraft()); setFormError(null); }}>
              {t("alert.addRule")}
            </button>
          )}

          {ruleDraft && (
            <form className="wizard-step" onSubmit={(e) => void saveRule(e)} noValidate data-testid="alert-rule-form">
              <p className="dialog-intro">{t("alert.ruleFormTitle")}</p>
              <label>
                <span>{t("alert.fieldHost")}</span>
                <select data-testid="alert-rule-host" value={ruleDraft.host_id} onChange={(e) => setRuleDraft({ ...ruleDraft, host_id: e.currentTarget.value })}>
                  <option value="">—</option>
                  {hosts.map((h: Host) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("alert.fieldKind")}</span>
                <select data-testid="alert-rule-kind" value={ruleDraft.kind} onChange={(e) => setRuleDraft({ ...ruleDraft, kind: e.currentTarget.value as AlertRuleKind })}>
                  <option value="disk">{t("alert.title.disk")}</option>
                  <option value="cpu">{t("alert.title.cpu")}</option>
                  <option value="process">{t("alert.title.process")}</option>
                  <option value="log">{t("alert.kindLog")}</option>
                </select>
              </label>
              {ruleDraft.kind === "disk" && (
                <>
                  <label>
                    <span>{t("alert.paramDiskMount")}</span>
                    <input data-testid="alert-rule-mount" value={paramOf(ruleDraft.params, "mount")} onChange={(e) => setRuleDraft({ ...ruleDraft, params: { ...ruleDraft.params, mount: e.currentTarget.value } })} />
                  </label>
                  <label>
                    <span>{t("alert.paramDiskThreshold")}</span>
                    <input type="number" min={1} max={100} data-testid="alert-rule-threshold" value={paramOf(ruleDraft.params, "threshold")} onChange={(e) => setRuleDraft({ ...ruleDraft, params: { ...ruleDraft.params, threshold: e.currentTarget.value } })} />
                  </label>
                </>
              )}
              {ruleDraft.kind === "cpu" && (
                <>
                  <label>
                    <span>{t("alert.paramCpuThreshold")}</span>
                    <input type="number" min={1} max={100} data-testid="alert-rule-cpu-threshold" value={paramOf(ruleDraft.params, "threshold")} onChange={(e) => setRuleDraft({ ...ruleDraft, params: { ...ruleDraft.params, threshold: e.currentTarget.value } })} />
                  </label>
                  <label>
                    <span>{t("alert.paramCpuConsecutive")}</span>
                    <input type="number" min={1} data-testid="alert-rule-consecutive" value={paramOf(ruleDraft.params, "consecutive")} onChange={(e) => setRuleDraft({ ...ruleDraft, params: { ...ruleDraft.params, consecutive: e.currentTarget.value } })} />
                  </label>
                </>
              )}
              {ruleDraft.kind === "process" && (
                <label>
                  <span>{t("alert.paramProcessComm")}</span>
                  <input data-testid="alert-rule-comm" value={paramOf(ruleDraft.params, "comm")} onChange={(e) => setRuleDraft({ ...ruleDraft, params: { ...ruleDraft.params, comm: e.currentTarget.value } })} />
                </label>
              )}
              {ruleDraft.kind === "log" && (
                <>
                  <label>
                    <span>{t("alert.paramLogPath")}</span>
                    <input data-testid="alert-rule-log-path" placeholder="/var/log/app.log" value={paramOf(ruleDraft.params, "path")} onChange={(e) => setRuleDraft({ ...ruleDraft, params: { ...ruleDraft.params, path: e.currentTarget.value } })} />
                  </label>
                  <label>
                    <span>{t("alert.paramLogPattern")}</span>
                    <input data-testid="alert-rule-log-pattern" placeholder="FATAL|ERROR" value={paramOf(ruleDraft.params, "pattern")} onChange={(e) => setRuleDraft({ ...ruleDraft, params: { ...ruleDraft.params, pattern: e.currentTarget.value } })} />
                  </label>
                  <label>
                    <span>{t("alert.paramLogInterval")}</span>
                    <input type="number" min={5} data-testid="alert-rule-log-interval" value={paramOf(ruleDraft.params, "interval")} onChange={(e) => setRuleDraft({ ...ruleDraft, params: { ...ruleDraft.params, interval: e.currentTarget.value } })} />
                  </label>
                </>
              )}
              <fieldset>
                <legend>{t("alert.fieldChannels")}</legend>
                {channels.length === 0 && <p className="settings-hint">{t("alert.errNoChannelHint")}</p>}
                {channels.map((c) => (
                  <label key={c.id} className="notify-mute-row">
                    <Checkbox
                      testid={`alert-rule-channel-${c.id}`}
                      checked={ruleDraft.channels.includes(c.id)}
                      onChange={() => toggleDraftChannel(c.id)}
                    />
                    <span>{t(`alert.kind.${c.kind}`)}</span>
                  </label>
                ))}
              </fieldset>
              <label>
                <span>{t("alert.fieldRateLimit")}</span>
                <input type="number" min={0} data-testid="alert-rule-ratelimit" value={ruleDraft.rate_limit} onChange={(e) => setRuleDraft({ ...ruleDraft, rate_limit: e.currentTarget.value })} />
              </label>
              <label>
                <span>{t("alert.fieldMuteWindow")}</span>
                <input data-testid="alert-rule-mutewindow" placeholder="22:00-08:00" value={ruleDraft.mute_window} onChange={(e) => setRuleDraft({ ...ruleDraft, mute_window: e.currentTarget.value })} />
              </label>
              {formError && (
                <p className="form-error" data-testid="alert-form-error">
                  {formError}
                </p>
              )}
              <div className="form-actions">
                <button type="button" data-testid="alert-rule-cancel" onClick={() => setRuleDraft(null)}>
                  {t("common.cancel")}
                </button>
                <button type="submit" className="btn-accent" data-testid="alert-rule-save">
                  {t("common.save")}
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {formError && !channelDraft && !ruleDraft && (
        <p className="form-error" data-testid="alert-settings-error">
          {formError}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn-accent" data-testid="alert-settings-close" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}
