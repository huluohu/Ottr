// McpSettings（Phase 4 Task 3，C1；UI 批次一 Task 4 迁右侧 dock）：MCP server
// 设置面板（工具菜单 → workspace/ToolDialog 弹框承载，开合由 toolDialog 单槽驱动；
// 组件逻辑零改动，仅外壳从 overlay 对话框换为 dock 内容形态）。
// * 总开关（settings mcp.enabled；Rust 侧同步起/停 UDS listener，改设即生效）；
// * 运行状态行：监听中/已停止 + socket 绝对路径（客户端接入配置说明用）；
// * 接入片段：`ottr-mcp` relay 子进程的标准 mcpServers 配置形态
//   （socket 路径经 --socket 显式传入，完整文档见 docs/mcp.md）；
// * 授权矩阵：主机粒度 can_list / can_exec / exec_approval 三个开关 +
//   read_file 目录白名单（逗号分隔，回车/失焦保存）——默认全拒，无授权行 =
//   该主机对 MCP 客户端完全不可见；审批框组件在 McpApprovalDialog（全局挂载）。
import { useCallback, useEffect, useRef, useState } from "react";
import { platform as detectPlatform } from "../shortcuts/registry";
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
import { InfoHint } from "../ui/InfoHint";

export interface McpSettingsProps {
  open: boolean;
}

/** read_file 白名单输入框的未保存草稿（grant id → 原文；失焦/回车保存）。 */
type PathsDraft = Record<number, string>;

export function McpSettings({ open }: McpSettingsProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [grants, setGrants] = useState<McpGrant[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pathsDraft, setPathsDraft] = useState<PathsDraft>({});
  const [showSnippet, setShowSnippet] = useState(false);
  /** ottr-mcp relay 可执行文件期望路径（主程序同目录；null = 未找到）。 */
  const [relayPath, setRelayPath] = useState<string | null>(null);
  // 接入片段复制反馈（2026-10-16 用户需求）：已复制 1.5s 回弹；失败不装
  // 「已复制」（诚实面，与快捷命令插件/Terminal 剪贴板路径同口径）。
  const [snippetCopied, setSnippetCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const [s, g, h] = await Promise.all([
      vaultApi.mcp.status(),
      vaultApi.mcp.grantsList().catch(() => [] as McpGrant[]), // 锁定态：列表可空呈现
      vaultApi.hosts.list().catch(() => [] as Host[]),
    ]);
    // 判空收口（2026-10-31）：dev 预览环境对未命中命令一律回 null（非
    // rejection，catch 不触发）——null.map 直接把面板炸进错误边界。列表面
    // 一律阵列化，状态面本就 null 安全。
    setStatus(s ?? null);
    setGrants(Array.isArray(g) ? g : []);
    setHosts(Array.isArray(h) ? h : []);
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void refresh().catch((e) => setError(String(e)));
    // relay 路径独立取（mcp_status 之外的单命令；失败 = 未找到，前端如实回落）
    void vaultApi.mcp
      .relayPath()
      .then(setRelayPath)
      .catch(() => setRelayPath(null));
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

  async function copySnippet() {
    if (!snippet) return;
    try {
      // 全局剪贴板语义（2026-10-20）：统一走 copyText（按配置自动清空）
      const { copyText } = await import("../ui/clipboard");
      await copyText(snippet);
      setSnippetCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setSnippetCopied(false), 1500);
    } catch {
      // 剪贴板不可用（权限/非安全上下文）：按钮维持原文案，不装「已复制」。
    }
  }

  function toggleEnabled(on: boolean) {
    void run(() => vaultApi.mcp.setEnabled(on));
  }

  /** 审批超时改配（2026-10-13「MCP 深化」）：run 自带刷新——新引擎新超时。 */
  function setApprovalTimeout(secs: number) {
    void run(() => vaultApi.mcp.setApprovalTimeout(secs));
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
  // Windows 传输 = 命名管道（--pipe <name>）；unix = UDS（--socket <path>）。
  // 与 Rust 侧 socket_path/parse_args 的口径逐字对齐（mod.rs / ottr-mcp.rs）。
  // command = relay 真实路径（Rust mcp_relay_path 探测主程序同目录，随应用
  // 分发——2026-10-31 用户需求：直接配置好不让用户手改）；未找到 = 占位符。
  const command = relayPath ?? "<path-to-ottr-mcp>";
  const snippet = socket
    ? JSON.stringify(
        {
          mcpServers: {
            ottr: {
              command,
              args: [detectPlatform() === "win" ? "--pipe" : "--socket", socket],
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
          {/* 开关行 div 包行（2026-10-16 用户反馈：label 包行全行可点命中面过大），
              可访问名经 Switch label prop 补回。 */}
          <div className="settings-row" data-testid="mcp-enabled-row">
            <span className="settings-label">{t("mcp.enabled")}</span>
            <InfoHint text={t("mcp.enabledHint")} />
            <Switch
              testid="mcp-enabled-toggle"
              label={t("mcp.enabled")}
              checked={status?.enabled ?? false}
              onChange={(e) => toggleEnabled(e.currentTarget.checked)}
            />
          </div>
          <div className="settings-row" data-testid="mcp-listening">
            <span className="settings-label">{t("mcp.listening")}</span>
            <span className={`vault-mode-badge ${status?.listening ? "vault-mode-keyring" : ""}`}>
              {status?.listening ? t("mcp.listeningOn") : t("mcp.listeningOff")}
            </span>
          </div>
          {/* 审批超时可配（2026-10-13「MCP 深化」）：改配 = 落盘 + 监听中重启
              listener（新引擎新超时即时生效；在途审批随重启清空——开关翻转同
              语义）。范围 10-600s 由 Rust 注册表拒绝，UI 给四档常用值。 */}
          <label className="settings-row" data-testid="mcp-approval-timeout-row">
            <span className="settings-label">{t("mcp.approvalTimeout")}</span>
            <InfoHint text={t("mcp.approvalTimeoutHint")} />
            <select
              data-testid="mcp-approval-timeout"
              value={status?.approval_timeout ?? 60}
              onChange={(e) => setApprovalTimeout(Number(e.currentTarget.value))}
            >
              {[30, 60, 120, 300].map((secs) => (
                <option key={secs} value={secs}>
                  {t("mcp.approvalTimeoutSecs", { count: secs })}
                </option>
              ))}
            </select>
          </label>
          {socket && (
            <p className="settings-hint" data-testid="mcp-socket-path">
              {t("mcp.socketPath")}: <code>{socket}</code>
            </p>
          )}
          <div className="settings-row">
            <span className="settings-label">{t("mcp.snippetToggle")}</span>
            <InfoHint text={t("mcp.snippetHint")} />
            <button type="button" data-testid="mcp-toggle-snippet" onClick={() => setShowSnippet((v) => !v)}>
              {t("mcp.snippetToggle")}
            </button>
          </div>
          {showSnippet && (
            <div data-testid="mcp-snippet">
              <InfoHint text={t("mcp.snippetDocs")} />
              {socket && !relayPath && (
                <p className="form-error" data-testid="mcp-relay-missing">
                  {t("mcp.relayMissing")}
                </p>
              )}
              {/* 代码块自带右上角复制钮（2026-10-31 用户需求）：pre 横向滚动
                  兜底长路径——不再把设置页撑出横向滚动条。 */}
              {snippet && (
                <div className="mcp-snippet">
                  <button
                    type="button"
                    className="mcp-snippet-copy"
                    data-testid="mcp-copy-snippet"
                    onClick={() => void copySnippet()}
                  >
                    {snippetCopied ? t("mcp.snippetCopied") : t("mcp.snippetCopy")}
                  </button>
                  <pre className="mcp-snippet-pre">
                    <code>{snippet}</code>
                  </pre>
                </div>
              )}
              {!snippet && (
                <pre className="mcp-snippet-pre">
                  <code>{t("mcp.snippetUnavailable")}</code>
                </pre>
              )}
            </div>
          )}
        </section>

        <section aria-label={t("mcp.grantsSection")} data-testid="mcp-grants-section">
          <div className="settings-head">
            <h3>{t("mcp.grantsSection")}</h3>
            <InfoHint text={t("mcp.grantsHint")} />
          </div>
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

    </div>
  );
}
