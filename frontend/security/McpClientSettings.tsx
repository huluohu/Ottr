// McpClientSettings（Ottr 作为 **MCP 客户端**——连接外部 MCP server 的设置面）。
//
// 与 McpSettings（server 侧：把 Ottr 的主机暴露给 AI 客户端）严格对偶：
//   * 清单：已配置的外部 server（名字 / 命令 / 参数 / 启用开关 / env 变量名）；
//   * 新增 / 编辑 / 删除（删除走确认框——沿用 known_hosts 删除确认的既有形态）；
//   * env 变量用**密码框**输入（它们是密钥：值只落 vault 密文面，列表只回显名）；
//   * 「查看工具」→ 起子进程的一次性会话（initialize → tools/list）；
//   * 「调用」→ 小对话框填参数 JSON → tools/call → 展示结果文本与 isError 标记。
//
// 【env 编辑语义】（与 Rust 侧 mcp_server_upsert 逐字对齐）
//   * 输入框留空 = **保留旧值不动**（密文永不出库，UI 也就无从回显）；
//   * 填了新值 = 覆盖该变量；
//   * 删除 = 显式点「删除」（走 mcp_server_env_delete：清密文 + 摘名字）。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  vaultApi,
  type McpServerInfo,
  type McpServerInput,
  type McpToolInfo,
  type McpToolResult,
} from "../vault/api";
import { Switch } from "../ui/Switch";
import { InfoHint } from "../ui/InfoHint";
import { FormDialog } from "../ui/FormDialog";
import { useEscClose } from "../ui/useEscClose";

/** 编辑表单里的一个环境变量条目（value 空 = 保留旧值）。
 *  `existing` = 该变量已在 vault 密文面（名字只读，删除走 env_delete 命令）。 */
interface EnvEntry {
  name: string;
  value: string;
  existing: boolean;
}

/** 工具列表面板（某个 server 的 tools/list 结果）。 */
interface ToolsPanel {
  server: McpServerInfo;
  tools: McpToolInfo[];
  loading: boolean;
  error: string | null;
}

/** 调用对话框状态。 */
interface CallState {
  server: McpServerInfo;
  tool: string;
  argsText: string;
  running: boolean;
  result: McpToolResult | null;
  error: string | null;
}

export function McpClientSettings() {
  const { t } = useTranslation();
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 编辑表单（null = 未打开；formServer=null = 新建）。
  const [formOpen, setFormOpen] = useState(false);
  const [formServer, setFormServer] = useState<McpServerInfo | null>(null);
  const [formName, setFormName] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);
  const [formEnv, setFormEnv] = useState<EnvEntry[]>([]);

  const [confirmDelete, setConfirmDelete] = useState<McpServerInfo | null>(null);
  const [toolsPanel, setToolsPanel] = useState<ToolsPanel | null>(null);
  const [call, setCall] = useState<CallState | null>(null);

  // 弹层栈：删除确认 > 工具面板 > 调用框（Esc 只收最上层）。
  useEscClose(confirmDelete != null || toolsPanel != null || call != null, () => {
    if (confirmDelete != null) setConfirmDelete(null);
    else if (call != null) setCall(null);
    else setToolsPanel(null);
  });

  const refresh = useCallback(async () => {
    try {
      const list = await vaultApi.mcpClients.list();
      setServers(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** 打开表单（新建 or 编辑）。 */
  function openForm(server: McpServerInfo | null) {
    setFormServer(server);
    setFormName(server?.name ?? "");
    setFormCommand(server?.command ?? "");
    setFormArgs(server?.args.join("\n") ?? "");
    setFormEnabled(server?.enabled ?? true);
    // 已配置的变量名进表单（值留空 = 保留旧值；密文永不出库）。
    setFormEnv((server?.envNames ?? []).map((name) => ({ name, value: "", existing: true })));
    setFormOpen(true);
  }

  /** 提交表单：env 只提交「用户真填了值」的项（留空 = 保留旧值）。 */
  async function submitForm() {
    if (!formCommand.trim()) {
      setError(t("mcpClient.commandRequired"));
      return;
    }
    const env: Record<string, string | null> = {};
    for (const e of formEnv) {
      const name = e.name.trim();
      if (!name) continue;
      env[name] = e.value === "" ? null : e.value;
    }
    const input: McpServerInput = {
      id: formServer?.id ?? null,
      name: formName.trim() || formCommand.trim(),
      command: formCommand.trim(),
      args: formArgs
        .split("\n")
        .map((a) => a.trim())
        .filter((a) => a.length > 0),
      enabled: formEnabled,
      env,
    };
    setFormOpen(false);
    await run(() => vaultApi.mcpClients.upsert(input));
  }

  /** 启用位翻转（配置保留，仅不可用）。 */
  function toggleEnabled(server: McpServerInfo, enabled: boolean) {
    void run(async () => {
      await vaultApi.mcpClients.upsert({
        id: server.id,
        name: server.name,
        command: server.command,
        args: server.args,
        enabled,
        env: {}, // 空 = 全部变量保留旧值不动
      });
    });
  }

  /** 列工具（起进程的一次性会话）。 */
  async function openTools(server: McpServerInfo) {
    setToolsPanel({ server, tools: [], loading: true, error: null });
    try {
      const tools = await vaultApi.mcpClients.tools(server.id);
      setToolsPanel({ server, tools: Array.isArray(tools) ? tools : [], loading: false, error: null });
    } catch (e) {
      setToolsPanel({
        server,
        tools: [],
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 打开调用框（默认参数 = 空对象）。 */
  function openCall(server: McpServerInfo, tool: string) {
    setCall({ server, tool, argsText: "{}", running: false, result: null, error: null });
  }

  /** 执行调用。 */
  async function runCall() {
    if (!call) return;
    if (!call.tool.trim()) {
      // 工具名空 = 无从调用（从清单直调时工具名要手填）。
      setCall({ ...call, result: null, error: t("mcpClient.toolRequired") });
      return;
    }
    setCall({ ...call, running: true, result: null, error: null });
    try {
      const result = await vaultApi.mcpClients.call(call.server.id, call.tool, call.argsText);
      setCall({ ...call, running: false, result, error: null });
    } catch (e) {
      setCall({
        ...call,
        running: false,
        result: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 删除某个环境变量（已存在的走 env_delete：清密文 + 摘名字；新加的直接摘）。 */
  function removeEnv(index: number) {
    const entry = formEnv[index];
    if (!entry) return;
    if (entry.existing && formServer) {
      const server = formServer;
      void run(() => vaultApi.mcpClients.envDelete(server.id, entry.name));
    }
    setFormEnv((list) => list.filter((_, i) => i !== index));
  }

  return (
    <section
      aria-label={t("mcpClient.section")}
      data-testid="mcp-client-section"
      className="mcp-client-section"
    >
      <div className="settings-head">
        <h3>{t("mcpClient.section")}</h3>
        <InfoHint text={t("mcpClient.sectionHint")} />
      </div>
      {servers.length === 0 && (
        <p className="settings-hint" data-testid="mcp-client-empty">
          {t("mcpClient.empty")}
        </p>
      )}
      {servers.map((s) => (
        <div key={s.id} className="settings-row mcp-client-row" data-testid={`mcp-client-row-${s.id}`}>
          <span className="settings-label">{s.name}</span>
          <code className="mcp-client-cmd" data-testid={`mcp-client-cmd-${s.id}`}>
            {[s.command, ...s.args].join(" ")}
          </code>
          <Switch
            testid={`mcp-client-enabled-${s.id}`}
            label={t("mcpClient.enabled")}
            checked={s.enabled}
            onChange={(e) => toggleEnabled(s, e.currentTarget.checked)}
          />
          {s.envNames.length > 0 && (
            <span className="settings-hint" data-testid={`mcp-client-env-${s.id}`}>
              {t("mcpClient.envNames", { names: s.envNames.join(", ") })}
            </span>
          )}
          <button
            type="button"
            data-testid={`mcp-client-tools-${s.id}`}
            onClick={() => void openTools(s)}
          >
            {t("mcpClient.tools")}
          </button>
          <button
            type="button"
            data-testid={`mcp-client-call-${s.id}`}
            onClick={() => openCall(s, "")}
          >
            {t("mcpClient.call")}
          </button>
          <button
            type="button"
            data-testid={`mcp-client-edit-${s.id}`}
            onClick={() => openForm(s)}
          >
            {t("common.edit")}
          </button>
          <button
            type="button"
            data-testid={`mcp-client-delete-${s.id}`}
            onClick={() => setConfirmDelete(s)}
          >
            {t("common.delete")}
          </button>
        </div>
      ))}
      <div className="settings-row">
        <button
          type="button"
          className="btn-accent"
          data-testid="mcp-client-add"
          onClick={() => openForm(null)}
        >
          {t("mcpClient.add")}
        </button>
      </div>

      {error && (
        <p className="form-error" data-testid="mcp-client-error">
          {error}
        </p>
      )}

      {/* --- 新增 / 编辑表单（弹框形态：设置页不因长表单被顶高）--- */}
      <FormDialog
        open={formOpen}
        title={formServer ? t("mcpClient.editTitle") : t("mcpClient.addTitle")}
        onClose={() => setFormOpen(false)}
        testid="mcp-client-form"
      >
        <label className="settings-row">
          <span className="settings-label">{t("mcpClient.name")}</span>
          <input
            type="text"
            data-testid="mcp-client-form-name"
            value={formName}
            placeholder={t("mcpClient.namePlaceholder")}
            onChange={(e) => setFormName(e.currentTarget.value)}
          />
        </label>
        <label className="settings-row">
          <span className="settings-label">{t("mcpClient.command")}</span>
          <input
            type="text"
            data-testid="mcp-client-form-command"
            value={formCommand}
            placeholder={t("mcpClient.commandPlaceholder")}
            onChange={(e) => setFormCommand(e.currentTarget.value)}
          />
        </label>
        <label className="settings-row mcp-client-args-row">
          <span className="settings-label">{t("mcpClient.args")}</span>
          <textarea
            data-testid="mcp-client-form-args"
            value={formArgs}
            placeholder={t("mcpClient.argsPlaceholder")}
            onChange={(e) => setFormArgs(e.currentTarget.value)}
          />
        </label>
        <p className="settings-hint">{t("mcpClient.argsHint")}</p>
        <div className="settings-row">
          <span className="settings-label">{t("mcpClient.enabled")}</span>
          <Switch
            testid="mcp-client-form-enabled"
            label={t("mcpClient.enabled")}
            checked={formEnabled}
            onChange={(e) => setFormEnabled(e.currentTarget.checked)}
          />
        </div>
        {/* env 变量（密码框：值是密钥；留空 = 保留旧值） */}
        <div className="settings-head">
          <h3>{t("mcpClient.envTitle")}</h3>
          <InfoHint text={t("mcpClient.envHint")} />
        </div>
        {formEnv.map((e, idx) => (
          <div key={idx} className="settings-row" data-testid={`mcp-client-env-row-${idx}`}>
            <input
              type="text"
              data-testid={`mcp-client-env-name-${idx}`}
              value={e.name}
              readOnly={e.existing}
              placeholder={t("mcpClient.envNamePlaceholder")}
              onChange={(ev) => {
                const name = ev.currentTarget.value;
                setFormEnv((list) =>
                  list.map((item, i) => (i === idx ? { ...item, name } : item)),
                );
              }}
            />
            <input
              type="password"
              data-testid={`mcp-client-env-value-${idx}`}
              value={e.value}
              placeholder={t("mcpClient.envValuePlaceholder")}
              onChange={(ev) => {
                const value = ev.currentTarget.value;
                setFormEnv((list) =>
                  list.map((item, i) => (i === idx ? { ...item, value } : item)),
                );
              }}
            />
            <button
              type="button"
              data-testid={`mcp-client-env-delete-${idx}`}
              onClick={() => removeEnv(idx)}
            >
              {t("common.delete")}
            </button>
          </div>
        ))}
        <div className="settings-row">
          <button
            type="button"
            data-testid="mcp-client-env-add"
            onClick={() => setFormEnv((list) => [...list, { name: "", value: "", existing: false }])}
          >
            {t("mcpClient.envAdd")}
          </button>
        </div>
        {formEnv.some((e) => e.name.trim() === "") && (
          <p className="settings-hint">{t("mcpClient.envNameHint")}</p>
        )}
        <div className="form-actions">
          <button type="button" data-testid="mcp-client-form-cancel" onClick={() => setFormOpen(false)}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-accent"
            data-testid="mcp-client-form-save"
            onClick={() => void submitForm()}
          >
            {t("common.save")}
          </button>
        </div>
      </FormDialog>

      {/* --- 删除确认（沿用 known_hosts 删除确认的既有形态）--- */}
      {confirmDelete && (
        <div
          className="overlay overlay-stacked"
          role="dialog"
          aria-modal="true"
          aria-label={t("mcpClient.deleteTitle")}
        >
          <div className="dialog mcp-client-delete-dialog" data-testid="mcp-client-delete-dialog">
            <h2>{t("mcpClient.deleteTitle")}</h2>
            <p className="dialog-intro" data-testid="mcp-client-delete-hint">
              {t("mcpClient.deleteHint", { name: confirmDelete.name })}
            </p>
            <div className="form-actions">
              <button
                type="button"
                data-testid="mcp-client-delete-cancel"
                onClick={() => setConfirmDelete(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn-accent"
                data-testid="mcp-client-delete-confirm"
                onClick={() => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  void run(() => vaultApi.mcpClients.remove(target.id));
                }}
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- 工具列表面板 --- */}
      {toolsPanel && (
        <div
          className="overlay overlay-stacked"
          role="dialog"
          aria-modal="true"
          aria-label={t("mcpClient.toolsTitle")}
        >
          <div className="dialog mcp-client-tools-dialog" data-testid="mcp-client-tools-dialog">
            <h2>{t("mcpClient.toolsTitle", { name: toolsPanel.server.name })}</h2>
            {toolsPanel.loading && <p className="settings-hint">{t("common.loading")}</p>}
            {toolsPanel.error && (
              <p className="form-error" data-testid="mcp-client-tools-error">
                {toolsPanel.error}
              </p>
            )}
            {!toolsPanel.loading && !toolsPanel.error && toolsPanel.tools.length === 0 && (
              <p className="settings-hint" data-testid="mcp-client-tools-empty">
                {t("mcpClient.toolsEmpty")}
              </p>
            )}
            {toolsPanel.tools.map((tool) => (
              <div key={tool.name} className="settings-row" data-testid={`mcp-client-tool-${tool.name}`}>
                <span className="settings-label">{tool.name}</span>
                <span className="settings-hint">{tool.description || t("mcpClient.noDescription")}</span>
                <button
                  type="button"
                  data-testid={`mcp-client-tool-call-${tool.name}`}
                  onClick={() => openCall(toolsPanel.server, tool.name)}
                >
                  {t("mcpClient.call")}
                </button>
              </div>
            ))}
            <div className="form-actions">
              <button
                type="button"
                data-testid="mcp-client-tools-close"
                onClick={() => setToolsPanel(null)}
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- 调用对话框（参数 JSON → 结果）--- */}
      {call && (
        <div
          className="overlay overlay-stacked"
          role="dialog"
          aria-modal="true"
          aria-label={t("mcpClient.callTitle")}
        >
          <div className="dialog mcp-client-call-dialog" data-testid="mcp-client-call-dialog">
            <h2>{t("mcpClient.callTitle", { tool: call.tool })}</h2>
            <label className="settings-row">
              <span className="settings-label">{t("mcpClient.toolName")}</span>
              <input
                type="text"
                data-testid="mcp-client-call-tool"
                value={call.tool}
                placeholder={t("mcpClient.toolNamePlaceholder")}
                onChange={(e) =>
                  setCall({ ...call, tool: e.currentTarget.value, result: null, error: null })
                }
              />
            </label>
            <label className="settings-row">
              <span className="settings-label">{t("mcpClient.callArgs")}</span>
              <textarea
                data-testid="mcp-client-call-args"
                value={call.argsText}
                onChange={(e) =>
                  setCall({ ...call, argsText: e.currentTarget.value, result: null, error: null })
                }
              />
            </label>
            <p className="settings-hint">{t("mcpClient.callArgsHint")}</p>
            <div className="form-actions">
              <button
                type="button"
                data-testid="mcp-client-call-close"
                onClick={() => setCall(null)}
              >
                {t("common.close")}
              </button>
              <button
                type="button"
                className="btn-accent"
                data-testid="mcp-client-call-run"
                disabled={call.running}
                onClick={() => void runCall()}
              >
                {call.running ? t("common.loading") : t("mcpClient.callRun")}
              </button>
            </div>
            {call.error && (
              <p className="form-error" data-testid="mcp-client-call-error">
                {call.error}
              </p>
            )}
            {call.result && (
              <div data-testid="mcp-client-call-result">
                {call.result.isError && (
                  <span className="vault-mode-badge vault-mode-password" data-testid="mcp-client-call-iserror">
                    {t("mcpClient.callFailed")}
                  </span>
                )}
                <pre className="mcp-client-result" data-testid="mcp-client-call-text">
                  <code>{call.result.text || t("mcpClient.callEmpty")}</code>
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
