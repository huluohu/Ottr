// McpSettings（Phase 4 Task 3，C1；UI 批次一 Task 4 迁右侧 dock）：MCP server
// 设置面板（工具菜单 → dock/DockPanel 承载，open/onClose 由 dock 单槽驱动；
// 组件逻辑零改动，仅外壳从 overlay 对话框换为 dock 内容形态）。
// * 总开关（settings mcp.enabled；Rust 侧同步起/停 UDS listener，改设即生效）；
// * 运行状态行：监听中/已停止 + socket 绝对路径（Claude Desktop 接入说明用）；
// * 接入片段：`ottr-mcp` relay 子进程的 claude_desktop_config.json 形态
//   （socket 路径经 --socket 显式传入，完整文档见 docs/mcp.md）；
// * 授权矩阵：主机粒度 can_list / can_exec / exec_approval 三个开关 +
//   read_file 目录白名单（逗号分隔，回车/失焦保存）——默认全拒，无授权行 =
//   该主机对 MCP 客户端完全不可见；审批框组件在 McpApprovalDialog（全局挂载）。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  vaultApi,
  type Host,
  type McpGrant,
  type McpGrantInput,
  type McpStatus,
} from "../vault/api";
import { Switch } from "../ui/Switch";
import { Checkbox } from "../ui/Checkbox";

export interface McpSettingsProps {
  open: boolean;
  onClose: () => void;
}

/** read_file 白名单输入框的未保存草稿（grant id → 原文；失焦/回车保存）。 */
type PathsDraft = Record<number, string>;

export function McpSettings({ open, onClose }: McpSettingsProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [grants, setGrants] = useState<McpGrant[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pathsDraft, setPathsDraft] = useState<PathsDraft>({});
  const [showSnippet, setShowSnippet] = useState(false);

  const refresh = useCallback(async () => {
    const [s, g, h] = await Promise.all([
      vaultApi.mcp.status(),
      vaultApi.mcp.grantsList().catch(() => [] as McpGrant[]), // 锁定态：列表可空呈现
      vaultApi.hosts.list().catch(() => [] as Host[]),
    ]);
    setStatus(s);
    setGrants(g);
    setHosts(h);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void refresh().catch((e) => setError(String(e)));
  }, [open, refresh]);

  if (!open) return null;

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function toggleEnabled(on: boolean) {
    void run(() => vaultApi.mcp.setEnabled(on));
  }

  function flipGrant(g: McpGrant, patch: Partial<McpGrantInput>) {
    void run(() =>
      vaultApi.mcp.grantsUpsert({
        host_id: g.host_id,
        can_list: g.can_list,
        can_exec: g.can_exec,
        exec_approval: g.exec_approval,
        read_paths: g.read_paths,
        ...patch,
      }),
    );
  }

  function savePaths(g: McpGrant) {
    const raw = pathsDraft[g.id];
    if (raw === undefined) return;
    const read_paths = raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    void run(() => vaultApi.mcp.grantsUpsert({
      host_id: g.host_id,
      can_list: g.can_list,
      can_exec: g.can_exec,
      exec_approval: g.exec_approval,
      read_paths,
    }));
  }

  function addGrant(hostId: number) {
    if (!hostId) return;
    void run(() =>
      vaultApi.mcp.grantsUpsert({
        host_id: hostId,
        can_list: true, // 新授权缺省：可见 + 可执行但逐次审批（安全侧起步档）
        can_exec: true,
        exec_approval: true,
        read_paths: [],
      }),
    );
  }

  const hostName = (id: number) => hosts.find((h) => h.id === id)?.name ?? `#${id}`;
  const grantedIds = new Set(grants.map((g) => g.host_id));
  const addable = hosts.filter((h) => !grantedIds.has(h.id));
  const socket = status?.socket_path ?? null;
  const snippet = socket
    ? JSON.stringify(
        {
          mcpServers: {
            ottr: {
              command: "<path-to-ottr-mcp>",
              args: ["--socket", socket],
            },
          },
        },
        null,
        2,
      )
    : null;

  return (
    // dock 内容形态（T4）：标题由 dock 壳供给；底部关闭按钮保留（长内容
    // 滚动后无需回到 dock 头部即可关闭）。
    <div className="dock-entity settings-dialog" role="region" aria-label={t("mcp.title")} data-testid="mcp-settings">
        <section aria-label={t("mcp.serverSection")} data-testid="mcp-server-section">
          <h3>{t("mcp.serverSection")}</h3>
          <label className="settings-row" data-testid="mcp-enabled-row">
            <span className="settings-label">{t("mcp.enabled")}</span>
            <Switch
              testid="mcp-enabled-toggle"
              checked={status?.enabled ?? false}
              onChange={(e) => toggleEnabled(e.currentTarget.checked)}
            />
          </label>
          <p className="settings-hint">{t("mcp.enabledHint")}</p>
          <div className="settings-row" data-testid="mcp-listening">
            <span className="settings-label">{t("mcp.listening")}</span>
            <span className={`vault-mode-badge ${status?.listening ? "vault-mode-keyring" : ""}`}>
              {status?.listening ? t("mcp.listeningOn") : t("mcp.listeningOff")}
            </span>
          </div>
          {socket && (
            <p className="settings-hint" data-testid="mcp-socket-path">
              {t("mcp.socketPath")}: <code>{socket}</code>
            </p>
          )}
          <div className="settings-row">
            <button type="button" data-testid="mcp-toggle-snippet" onClick={() => setShowSnippet((v) => !v)}>
              {t("mcp.snippetToggle")}
            </button>
          </div>
          {showSnippet && (
            <div data-testid="mcp-snippet">
              <p className="settings-hint">{t("mcp.snippetHint")}</p>
              <pre className="host-key-fp">
                <code>{snippet ?? t("mcp.snippetUnavailable")}</code>
              </pre>
              <p className="settings-hint">{t("mcp.snippetDocs")}</p>
            </div>
          )}
        </section>

        <section aria-label={t("mcp.grantsSection")} data-testid="mcp-grants-section">
          <h3>{t("mcp.grantsSection")}</h3>
          <p className="settings-hint">{t("mcp.grantsHint")}</p>
          {grants.length === 0 && (
            <p className="settings-hint" data-testid="mcp-no-grants">
              {t("mcp.noGrants")}
            </p>
          )}
          {grants.map((g) => (
            <div key={g.id} className="settings-row mcp-grant-row" data-testid={`mcp-grant-${g.host_id}`}>
              <span className="settings-label">{hostName(g.host_id)}</span>
              <label>
                <Checkbox
                  testid={`mcp-can-list-${g.host_id}`}
                  checked={g.can_list}
                  onChange={(e) => flipGrant(g, { can_list: e.currentTarget.checked })}
                />{" "}
                {t("mcp.canList")}
              </label>
              <label>
                <Checkbox
                  testid={`mcp-can-exec-${g.host_id}`}
                  checked={g.can_exec}
                  onChange={(e) => flipGrant(g, { can_exec: e.currentTarget.checked })}
                />{" "}
                {t("mcp.canExec")}
              </label>
              <label>
                <Checkbox
                  testid={`mcp-approval-${g.host_id}`}
                  checked={g.exec_approval}
                  onChange={(e) => flipGrant(g, { exec_approval: e.currentTarget.checked })}
                />{" "}
                {t("mcp.approval")}
              </label>
              <input
                type="text"
                data-testid={`mcp-read-paths-${g.host_id}`}
                placeholder={t("mcp.readPathsPlaceholder")}
                value={pathsDraft[g.id] ?? g.read_paths.join(", ")}
                onChange={(e) => {
                  // currentTarget 在事件派发结束后即被 React 置空——先取值再进 updater。
                  const v = e.currentTarget.value;
                  setPathsDraft((d) => ({ ...d, [g.id]: v }));
                }}
                onBlur={() => savePaths(g)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") savePaths(g);
                }}
              />
              <button
                type="button"
                data-testid={`mcp-grant-delete-${g.host_id}`}
                onClick={() => void run(() => vaultApi.mcp.grantsDelete(g.id))}
              >
                {t("common.delete")}
              </button>
            </div>
          ))}
          {addable.length > 0 && (
            <label className="settings-row" data-testid="mcp-add-row">
              <span className="settings-label">{t("mcp.add")}</span>
              <select
                data-testid="mcp-add-select"
                value={0}
                onChange={(e) => addGrant(Number(e.currentTarget.value))}
              >
                <option value={0}>{t("mcp.addPick")}</option>
                {addable.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="settings-hint">{t("mcp.execNote")}</p>
        </section>

        {error && (
          <p className="form-error" data-testid="mcp-error">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button type="button" className="btn-accent" data-testid="mcp-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
    </div>
  );
}
