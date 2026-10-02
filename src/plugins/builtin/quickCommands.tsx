// 内置示例插件②：快捷命令包（Phase 4 Task 6，C3 foundation）。
// manifest 声明 palette.commands + sidebar.card；贡献四条只读快捷命令
// （明文展示 + 显式复制到剪贴板）与一张承载它们的侧栏卡片。
// 安全面：插件不注入终端、不自动执行——命令始终以原文可见，用户显式复制。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OttrPlugin, PluginQuickCommand } from "../types";

export const QUICK_COMMANDS_CARD_ID = "quick-commands.card";

/** 快捷命令包内容（纯数据；labelKey 双语在 i18n plugins.quick.*）。 */
export const QUICK_COMMANDS: readonly PluginQuickCommand[] = [
  { id: "quick-commands.df", labelKey: "plugins.quick.df", command: "df -h" },
  { id: "quick-commands.free", labelKey: "plugins.quick.free", command: "free -m" },
  { id: "quick-commands.uptime", labelKey: "plugins.quick.uptime", command: "uptime" },
  { id: "quick-commands.dockerPs", labelKey: "plugins.quick.dockerPs", command: "docker ps" },
];

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function QuickCommandsCard({ commands }: { commands: readonly PluginQuickCommand[] }) {
  const { t } = useTranslation();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  // 卸载时清定时器（复制的「已复制」回弹不跨生命周期泄漏）。
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className="plugin-card" data-testid="plugin-quick-card">
      <div className="plugin-card-title">{t("plugins.quick.title")}</div>
      {commands.map((cmd) => (
        <div className="plugin-cmd-row" key={cmd.id} data-testid="plugin-cmd-row">
          <span className="plugin-cmd-label">{t(cmd.labelKey)}</span>
          <code className="plugin-cmd-text">{cmd.command}</code>
          <button
            className="plugin-cmd-copy"
            data-testid={`plugin-cmd-copy-${cmd.id}`}
            aria-label={`${t("plugins.quick.copy")}: ${cmd.command}`}
            onClick={() => {
              void copyText(cmd.command).then(() => {
                setCopiedId(cmd.id);
                if (timer.current !== null) window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setCopiedId(null), 1500);
              });
            }}
          >
            {copiedId === cmd.id ? t("plugins.quick.copied") : t("plugins.quick.copy")}
          </button>
        </div>
      ))}
    </div>
  );
}

export const QUICK_COMMANDS_PLUGIN: OttrPlugin = {
  manifest: {
    name: "quick-commands",
    version: "0.1.0",
    titleKey: "plugins.quick.title",
    permissions: ["palette.commands", "sidebar.card"],
  },
  sidebarCards: [{ id: QUICK_COMMANDS_CARD_ID }],
  quickCommands: [...QUICK_COMMANDS],
};
