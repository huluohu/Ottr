// McpApprovalDialog（Phase 4 Task 3，C1）：MCP exec_command 逐次审批确认框。
// ottr://mcp-approval 事件（Rust UiApprovalGate 登记 → 发事件 → 阻塞等裁定，
// 60s 超时即拒）→ 本框展示主机名 + 命令原文 → 允许/拒绝经 mcp_approval_decision
// 回传。多条审批排队逐条呈现（门各自的 60s 窗独立计时，前端不合并——命令面
// 不同合并会造成误批）。展示形态对齐 HostKeyDialog（alertdialog + 命令等宽字体
// ——核对场景，不截断）。
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { vaultApi, type McpApprovalAsk } from "../vault/api";

export const MCP_APPROVAL_EVENT = "ottr://mcp-approval";

/** 命令原文控制字符显形（fix 1/5 I-2）：SSH exec 内嵌换行 = 远端执行多条
 * 命令（"df -h\nrm -rf /"），HTML 默认折叠会把多行呈现成一行——「人批原文」
 * 的补偿控制因此失明。⏎/␍/⇥ 标记 + pre-wrap 双保险：标记让换行「可数」，
 * pre-wrap 让原文按真实行折显。单遍 replace（combined regex）——分步替换会
 * 把先前引入的 ⏎ 后随换行再吃一遍，产出 ␍⏎⏎ 双标记。 */
export function visualizeCommand(raw: string): string {
  return raw.replace(/\r\n|\r|\n|\t/g, (m) =>
    m === "\r\n" ? "␍⏎\n" : m === "\r" ? "␍\n" : m === "\n" ? "⏎\n" : "⇥",
  );
}

export function McpApprovalDialog() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<McpApprovalAsk[]>([]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<McpApprovalAsk>(MCP_APPROVAL_EVENT, (e) => {
      setQueue((q) => [...q, e.payload]);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // 非 Tauri 环境：审批框不出现，门按超时拒绝（安全侧默认）。
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (queue.length === 0) return null;
  const ask = queue[0];

  async function decide(allow: boolean) {
    try {
      await vaultApi.mcp.approvalDecision(ask.request_id, allow);
    } catch {
      // 裁定回传失败（窗口已超时等）：仅摘除本条——门侧早已按拒绝收尾。
    }
    setQueue((q) => q.filter((a) => a.request_id !== ask.request_id));
  }

  return (
    <div className="overlay" data-testid="mcp-approval-dialog">
      <div className="dialog host-key" role="alertdialog" aria-modal="true">
        <h2>{t("mcp.approvalTitle")}</h2>
        <p className="dialog-intro">
          {t("mcp.approvalIntro", { host: ask.host_name })}
        </p>
        <p className="host-key-fp">
          <span className="host-key-fp-label">{t("mcp.approvalCommand")}</span>
          <code
            data-testid="mcp-approval-command"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          >
            {visualizeCommand(ask.command)}
          </code>
        </p>
        <p className="settings-hint">{t("mcp.approvalHint")}</p>
        <div className="form-actions">
          <button
            type="button"
            data-testid="mcp-approval-deny"
            className="btn-accent"
            onClick={() => void decide(false)}
          >
            {t("mcp.approvalDeny")}
          </button>
          <button
            type="button"
            data-testid="mcp-approval-allow"
            className="btn-danger"
            onClick={() => void decide(true)}
          >
            {t("mcp.approvalAllow")}
          </button>
        </div>
      </div>
    </div>
  );
}
