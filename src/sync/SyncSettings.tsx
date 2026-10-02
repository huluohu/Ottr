// SyncSettings（Phase 5 Task 4）：设置页「同步」区——通道三选一配置 +
// 信封口令管理 + 测试连接 + 立即同步入口。
//
// 配置面（vault settings，sync.* 前缀）：
//   * sync.channel = "webdav" | "git" | "localdir"（当前通道）；
//   * sync.config.<kind> = 通道配置 JSON。sync.* 键走 validate_setting 的
//     未注册放行通道（T3 核实），且被 sync 导入三防线豁免（sync.* 不落库）
//     ——通道配置是本机簿记，永不被任何一次 pull 覆写。落库面 = vault
//     settings（本机主密码保护），与信封口令（云端面）分层，双层加密语义。
//   * git 通道 token：仅内嵌 https 远端（applyGitToken），明文存 vault
//     settings（本机加密面）；git.ts 文件头披露的临时克隆/进程参数暴露面
//     在 hint 明示。
// 口令面：系统钥匙链（sync_passphrase_* 命令，task-2 裁定归本任务落地）。
// 测试连接：用**当前草稿**（未保存也可测）构建 transport 走 test() 布尔面。
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi } from "../vault/api";
import { createGitTransport, tauriGitDeps, validateRepoUrl, type GitConfig } from "./git";
import { createLocalDirTransport, tauriLocalDirDeps } from "./localdir";
import { createWebdavTransport, type WebdavConfig } from "./webdav";
import type { SyncTransport } from "./transport";

export type SyncChannelKind = "webdav" | "git" | "localdir";

export interface WebdavChannelConfig {
  server: string;
  remotePath: string;
  username: string;
  password: string;
}

export interface GitChannelConfig {
  repoUrl: string;
  branch: string;
  token: string;
}

export interface LocalDirChannelConfig {
  dir: string;
}

/** 设置页同步区全量配置（三通道草稿并存，kind 指当前生效通道）。 */
export interface SyncChannelSettings {
  kind: SyncChannelKind | null;
  webdav: WebdavChannelConfig;
  git: GitChannelConfig;
  localdir: LocalDirChannelConfig;
}

export const SYNC_CHANNEL_KEY = "sync.channel";
export const syncConfigKey = (kind: SyncChannelKind): string => `sync.config.${kind}`;

export const EMPTY_CHANNEL_SETTINGS: SyncChannelSettings = {
  kind: null,
  webdav: { server: "", remotePath: "", username: "", password: "" },
  git: { repoUrl: "", branch: "main", token: "" },
  localdir: { dir: "" },
};

/** token 内嵌（git.ts 披露的可选路径）：仅 https 且尚无 userinfo 时插入
 * oauth2:<token>@；其余形态原样返回（凭据交给 credential helper）。 */
export function applyGitToken(repoUrl: string, token: string): string {
  const trimmed = token.trim();
  if (trimmed === "") return repoUrl;
  if (!/^https:\/\//i.test(repoUrl)) return repoUrl;
  const rest = repoUrl.replace(/^https:\/\//i, "");
  if (rest.includes("@")) return repoUrl;
  return `https://oauth2:${encodeURIComponent(trimmed)}@${rest}`;
}

/** 由配置构建生产 transport（SyncDialog 复用；git 通道走 Rust 白名单桥）。 */
export function buildTransport(kind: SyncChannelKind, cfg: SyncChannelSettings): SyncTransport {
  switch (kind) {
    case "webdav": {
      const webdav = cfg.webdav;
      const config: WebdavConfig = {
        server: webdav.server,
        remotePath: webdav.remotePath === "" ? undefined : webdav.remotePath,
        username: webdav.username,
        password: webdav.password,
      };
      return createWebdavTransport(config);
    }
    case "git": {
      const git = cfg.git;
      const config: GitConfig = {
        repoUrl: applyGitToken(git.repoUrl, git.token),
        branch: git.branch === "" ? undefined : git.branch,
      };
      return createGitTransport(config, tauriGitDeps());
    }
    case "localdir":
      return createLocalDirTransport({ dir: cfg.localdir.dir }, tauriLocalDirDeps());
  }
}

/** 读取持久化配置（vault settings；非 Tauri/后端不可达 → 空配置）。 */
export async function loadChannelSettings(): Promise<SyncChannelSettings> {
  try {
    const kind = await vaultApi.settings.get<SyncChannelKind>(SYNC_CHANNEL_KEY);
    const [webdav, git, localdir] = await Promise.all([
      vaultApi.settings.get<Partial<WebdavChannelConfig>>(syncConfigKey("webdav")),
      vaultApi.settings.get<Partial<GitChannelConfig>>(syncConfigKey("git")),
      vaultApi.settings.get<Partial<LocalDirChannelConfig>>(syncConfigKey("localdir")),
    ]);
    return {
      kind: kind === "webdav" || kind === "git" || kind === "localdir" ? kind : null,
      webdav: { ...EMPTY_CHANNEL_SETTINGS.webdav, ...(webdav ?? {}) },
      git: { ...EMPTY_CHANNEL_SETTINGS.git, ...(git ?? {}) },
      localdir: { ...EMPTY_CHANNEL_SETTINGS.localdir, ...(localdir ?? {}) },
    };
  } catch {
    return { ...EMPTY_CHANNEL_SETTINGS };
  }
}

export interface SyncSettingsProps {
  /** 立即同步入口（App 根部挂 SyncDialog）。 */
  onOpenSync: () => void;
}

export function SyncSettings({ onOpenSync }: SyncSettingsProps) {
  const { t } = useTranslation();
  const [cfg, setCfg] = useState<SyncChannelSettings>(EMPTY_CHANNEL_SETTINGS);
  const [saved, setSaved] = useState<SyncChannelSettings | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveFlash, setSaveFlash] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);

  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [passOpen, setPassOpen] = useState(false);
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [passError, setPassError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const loaded = await loadChannelSettings();
      if (!disposed) {
        setCfg(loaded);
        setSaved(loaded.kind === null ? null : loaded);
      }
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const stored = await invoke<string | null>("sync_passphrase_get");
        if (!disposed) setHasPassphrase(stored !== null && stored !== "");
      } catch {
        // 非 Tauri 环境：口令状态未知，按未设置呈现（设置时再报错）。
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const patch = (part: Partial<SyncChannelSettings>) => {
    setCfg((c) => ({ ...c, ...part }));
    setFormError(null);
    setSaveFlash(false);
    setTestResult(null);
  };

  /** 保存前校验（草稿面；test 连接共用）。返回 i18n key 或 null。 */
  function validateDraft(kind: SyncChannelKind, c: SyncChannelSettings): string | null {
    if (kind === "webdav" && !/^https?:\/\//i.test(c.webdav.server.trim())) {
      return "sync.errServerHttp";
    }
    if (kind === "git") {
      try {
        validateRepoUrl(applyGitToken(c.git.repoUrl, c.git.token));
      } catch (e) {
        return e instanceof Error ? `sync.errRepoUrl|${e.message}` : "sync.errRepoUrl";
      }
      if (c.git.branch.trim() === "") return "sync.errBranchEmpty";
    }
    if (kind === "localdir" && c.localdir.dir.trim() === "") return "sync.errDirEmpty";
    return null;
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (cfg.kind === null) return;
    const err = validateDraft(cfg.kind, cfg);
    if (err !== null) {
      setFormError(err);
      return;
    }
    try {
      const key = cfg.kind;
      await vaultApi.settings.set(SYNC_CHANNEL_KEY, key);
      const draft =
        key === "webdav" ? cfg.webdav : key === "git" ? { ...cfg.git, token: cfg.git.token } : cfg.localdir;
      await vaultApi.settings.set(syncConfigKey(key), draft);
      setSaved({ ...cfg });
      setSaveFlash(true);
      setFormError(null);
    } catch (err2) {
      setFormError(`sync.errSave|${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }

  async function testConnection() {
    if (cfg.kind === null) return;
    const err = validateDraft(cfg.kind, cfg);
    if (err !== null) {
      setFormError(err);
      return;
    }
    setTestBusy(true);
    setTestResult(null);
    try {
      const transport = buildTransport(cfg.kind, cfg);
      const ok = await transport.test();
      setTestResult(ok ? "ok" : "fail");
    } catch {
      setTestResult("fail");
    } finally {
      setTestBusy(false);
    }
  }

  async function chooseDir() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string" && picked !== "") {
        patch({ localdir: { ...cfg.localdir, dir: picked } });
      }
    } catch {
      // 非 Tauri 环境：系统目录框不存在，按钮无效果。
    }
  }

  async function submitPassphrase(e: FormEvent) {
    e.preventDefault();
    if (pass1 === "") {
      setPassError("sync.passphrase.errEmpty");
      return;
    }
    if (pass1 !== pass2) {
      setPassError("sync.passphrase.errMismatch");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sync_passphrase_set", { value: pass1 });
      setHasPassphrase(true);
      setPassOpen(false);
      setPass1("");
      setPass2("");
      setPassError(null);
    } catch (err) {
      setPassError(`sync.errSave|${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function forgetPassphrase() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sync_passphrase_del");
    } finally {
      setHasPassphrase(false);
    }
  }

  /** i18n 值含「|」后缀错误原文的复合键（errRepoUrl|<原始消息>）。 */
  const renderError = (key: string | null): string | null => {
    if (key === null) return null;
    const [k, ...rest] = key.split("|");
    return rest.length > 0 ? t(k, { message: rest.join("|") }) : t(k);
  };

  const canSyncNow = saved !== null;

  return (
    <section aria-label={t("sync.sectionTitle")} data-testid="sync-section">
      <h3>{t("settings.sectionSync")}</h3>
      <p className="settings-hint">{t("sync.channelHint")}</p>

      <div className="settings-row" role="radiogroup" aria-label={t("sync.channel")}>
        <span className="settings-label">{t("sync.channel")}</span>
        {(["webdav", "git", "localdir"] as const).map((kind) => (
          <label key={kind}>
            <input
              type="radio"
              name="sync-channel"
              data-testid={`sync-channel-${kind}`}
              checked={cfg.kind === kind}
              onChange={() => patch({ kind })}
            />
            {t(`sync.channel${kind[0]!.toUpperCase()}${kind.slice(1)}`)}
          </label>
        ))}
      </div>

      <form onSubmit={(e) => void save(e)} noValidate>
        {cfg.kind === "webdav" && (
          <>
            <label className="settings-row">
              <span className="settings-label">{t("sync.webdav.server")}</span>
              <input
                data-testid="sync-webdav-server"
                type="text"
                placeholder={t("sync.webdav.serverPlaceholder")}
                value={cfg.webdav.server}
                onChange={(e) => patch({ webdav: { ...cfg.webdav, server: e.currentTarget.value } })}
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">{t("sync.webdav.remotePath")}</span>
              <input
                data-testid="sync-webdav-remotepath"
                type="text"
                placeholder={t("sync.webdav.remotePathPlaceholder")}
                value={cfg.webdav.remotePath}
                onChange={(e) => patch({ webdav: { ...cfg.webdav, remotePath: e.currentTarget.value } })}
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">{t("sync.webdav.username")}</span>
              <input
                data-testid="sync-webdav-username"
                type="text"
                autoComplete="off"
                value={cfg.webdav.username}
                onChange={(e) => patch({ webdav: { ...cfg.webdav, username: e.currentTarget.value } })}
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">{t("sync.webdav.password")}</span>
              <input
                data-testid="sync-webdav-password"
                type="password"
                autoComplete="new-password"
                value={cfg.webdav.password}
                onChange={(e) => patch({ webdav: { ...cfg.webdav, password: e.currentTarget.value } })}
              />
            </label>
            <p className="settings-hint">{t("sync.webdav.hint")}</p>
          </>
        )}

        {cfg.kind === "git" && (
          <>
            <label className="settings-row">
              <span className="settings-label">{t("sync.git.repoUrl")}</span>
              <input
                data-testid="sync-git-repourl"
                type="text"
                value={cfg.git.repoUrl}
                onChange={(e) => patch({ git: { ...cfg.git, repoUrl: e.currentTarget.value } })}
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">{t("sync.git.branch")}</span>
              <input
                data-testid="sync-git-branch"
                type="text"
                value={cfg.git.branch}
                onChange={(e) => patch({ git: { ...cfg.git, branch: e.currentTarget.value } })}
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">{t("sync.git.token")}</span>
              <input
                data-testid="sync-git-token"
                type="password"
                autoComplete="off"
                value={cfg.git.token}
                onChange={(e) => patch({ git: { ...cfg.git, token: e.currentTarget.value } })}
              />
            </label>
            <p className="settings-hint">{t("sync.git.tokenHint")}</p>
            <p className="settings-hint">{t("sync.git.hint")}</p>
          </>
        )}

        {cfg.kind === "localdir" && (
          <>
            <div className="settings-row">
              <span className="settings-label">{t("sync.localdir.dir")}</span>
              <span data-testid="sync-localdir-dir">{cfg.localdir.dir}</span>
              <button type="button" data-testid="sync-localdir-choose" onClick={() => void chooseDir()}>
                {t("sync.localdir.choose")}
              </button>
            </div>
            <p className="settings-hint">{t("sync.localdir.hint")}</p>
          </>
        )}

        {cfg.kind !== null && (
          <div className="form-actions">
            <button type="submit" className="btn-accent" data-testid="sync-save">
              {saveFlash ? t("sync.saved") : t("sync.save")}
            </button>
            <button type="button" data-testid="sync-test" disabled={testBusy} onClick={() => void testConnection()}>
              {testBusy ? t("sync.testing") : t("sync.test")}
            </button>
          </div>
        )}
      </form>

      {formError !== null && (
        <p className="form-error" data-testid="sync-form-error">
          {renderError(formError)}
        </p>
      )}
      {testResult !== null && (
        <p className={testResult === "ok" ? "settings-hint" : "form-error"} data-testid="sync-test-result">
          {testResult === "ok" ? t("sync.testOk") : t("sync.testFail")}
        </p>
      )}

      {/* --- 信封口令（钥匙链） --- */}
      <div className="settings-row" data-testid="sync-passphrase-row">
        <span className="settings-label">{t("sync.passphrase.title")}</span>
        <span
          className={`vault-mode-badge vault-mode-${hasPassphrase ? "password" : "unknown"}`}
          data-testid="sync-passphrase-status"
        >
          {hasPassphrase ? t("sync.passphrase.statusSet") : t("sync.passphrase.statusUnset")}
        </span>
        <button type="button" data-testid="sync-passphrase-toggle" onClick={() => setPassOpen((v) => !v)}>
          {hasPassphrase ? t("sync.passphrase.change") : t("sync.passphrase.set")}
        </button>
        {hasPassphrase && (
          <button type="button" data-testid="sync-passphrase-forget" onClick={() => void forgetPassphrase()}>
            {t("sync.passphrase.forget")}
          </button>
        )}
      </div>
      <p className="settings-hint">{t("sync.passphrase.hint")}</p>
      {passOpen && (
        <form className="wizard-step" onSubmit={(e) => void submitPassphrase(e)} noValidate data-testid="sync-passphrase-form">
          <label>
            <span>{t("sync.passphrase.new")}</span>
            <input
              type="password"
              data-testid="sync-passphrase-new"
              autoComplete="new-password"
              value={pass1}
              onChange={(e) => setPass1(e.currentTarget.value)}
            />
          </label>
          <label>
            <span>{t("sync.passphrase.confirm")}</span>
            <input
              type="password"
              data-testid="sync-passphrase-confirm"
              autoComplete="new-password"
              value={pass2}
              onChange={(e) => setPass2(e.currentTarget.value)}
            />
          </label>
          <p className="settings-hint">{hasPassphrase ? t("sync.passphrase.changeHint") : t("sync.passphrase.hint")}</p>
          {passError !== null && (
            <p className="form-error" data-testid="sync-passphrase-error">
              {renderError(passError)}
            </p>
          )}
          <div className="form-actions">
            <button type="button" data-testid="sync-passphrase-cancel" onClick={() => setPassOpen(false)}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn-accent" data-testid="sync-passphrase-submit">
              {hasPassphrase ? t("sync.passphrase.change") : t("sync.passphrase.set")}
            </button>
          </div>
        </form>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="btn-accent"
          data-testid="sync-now"
          disabled={!canSyncNow}
          onClick={onOpenSync}
        >
          {t("sync.now")}
        </button>
      </div>
      {!canSyncNow && (
        <p className="settings-hint" data-testid="sync-need-channel">
          {t("sync.needChannel")}
        </p>
      )}
    </section>
  );
}
