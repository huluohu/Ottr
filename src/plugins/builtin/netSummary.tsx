// 内置示例插件①：网络摘要卡片（Phase 4 Task 6，C3 foundation）。
// manifest 声明 monitor.read + sidebar.card 两个权限；贡献一张侧栏卡片，
// 内容 = 当前标签监控窗口的网络吞吐摘要（复用 MonitorSidebar 的 formatRate
// 与 monitorStore 数据面——只读，零新采集）。
import { useMonitorStore } from "../../monitor/monitorStore";
import { formatRate } from "../../monitor/MonitorSidebar";
import { useTranslation } from "react-i18next";
import type { OttrPlugin } from "../types";

export const NET_SUMMARY_CARD_ID = "net-summary.card";

export function NetSummaryCard({ rustId }: { rustId: string | null }) {
  const { t } = useTranslation();
  const win = useMonitorStore((s) => (rustId ? s.windows[rustId] : undefined));
  const live = win?.status === "live" && win.latest != null;

  return (
    <div className="plugin-card" data-testid="plugin-net-card">
      <div className="plugin-card-title">{t("plugins.net.title")}</div>
      {live && win ? (
        <div className="plugin-net-row" data-testid="plugin-net-value">
          ↓ {formatRate(win.latest!.net_rx_bps)} · ↑ {formatRate(win.latest!.net_tx_bps)}
        </div>
      ) : (
        <div className="plugin-state" data-testid="plugin-net-waiting">
          {t("plugins.net.waiting")}
        </div>
      )}
    </div>
  );
}

export const NET_SUMMARY_PLUGIN: OttrPlugin = {
  manifest: {
    name: "net-summary",
    version: "0.1.0",
    titleKey: "plugins.net.title",
    permissions: ["monitor.read", "sidebar.card"],
  },
  sidebarCards: [{ id: NET_SUMMARY_CARD_ID }],
};
