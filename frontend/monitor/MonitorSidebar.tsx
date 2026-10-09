// MonitorSidebar（Phase 3 Task 1，B4 上半）：终端右栏折叠侧栏。
// * 折叠态 = 窄竖条按钮（开合状态 localStorage 记忆，默认收起——不打扰
//   首次使用的用户）；展开态 = CPU/内存/磁盘/负载/网络五行迷你图 + 当前值；
// * 数据源 = useMonitorStore（rustId 分桶；rustId 变化 = 重连，窗口重来）；
// * 状态面：host 未开启监控（off）→ 指引主机表单；远端非 Linux（unsupported）
//   → 「不支持」；采样终止（stopped）→ 提示重连。连接中/无数据显示等待态；
// * 主题/i18n 纪律：色板走 App.css 令牌，文案全走 t()。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkline } from "./Sparkline";
import { useMonitorStore, type MonitorWindow } from "./monitorStore";

/** 折叠态记忆键（布局面，同侧栏宽度先 localStorage 的既有惯例）。 */
const OPEN_KEY = "ottr.monitor.sidebarOpen";

export function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // 持久化失败不阻塞
  }
}

/** 速率人话格式（B/s → KB/s/MB/s；1 位小数，负载面不需要精确）。 */
export function formatRate(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

/** 内存人话格式（kB 入参）。 */
export function formatMemKB(kb: number): string {
  const mb = kb / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

/** 指标行：标签 + 当前值 + 迷你图。 */
function MetricRow({
  label,
  value,
  values,
  max,
}: {
  label: string;
  value: string;
  values: number[];
  max?: number;
}) {
  return (
    <div className="monitor-metric" data-testid="monitor-metric">
      <div className="monitor-metric-head">
        <span className="monitor-metric-label">{label}</span>
        <span className="monitor-metric-value" data-testid="monitor-metric-value">
          {value}
        </span>
      </div>
      <Sparkline values={values} max={max} label={label} />
    </div>
  );
}

/** 状态面（非 live 的四态文案）。 */
function StatusFace({ status, enabled }: { status: MonitorWindow["status"]; enabled: boolean }) {
  const { t } = useTranslation();
  if (status === "unsupported") {
    return (
      <p className="monitor-state" data-testid="monitor-unsupported">
        {t("monitor.unsupported")}
      </p>
    );
  }
  if (status === "stopped") {
    return (
      <p className="monitor-state" data-testid="monitor-stopped">
        {t("monitor.stopped")}
      </p>
    );
  }
  if (!enabled) {
    return (
      <p className="monitor-state" data-testid="monitor-off">
        {t("monitor.off")}
      </p>
    );
  }
  return (
    <p className="monitor-state" data-testid="monitor-waiting">
      {t("monitor.waiting")}
    </p>
  );
}

export function MonitorSidebar({
  rustId,
  enabled,
}: {
  /** 标签根会话的 Rust 会话 id（未连接 = null）。 */
  rustId: string | null;
  /** host.monitor_enabled（off 态指引的依据）。 */
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(loadSidebarOpen);
  const win = useMonitorStore((s) => (rustId ? s.windows[rustId] : undefined));

  if (!open) {
    return (
      <button
        className="monitor-rail"
        data-testid="monitor-rail"
        aria-label={t("monitor.open")}
        title={t("monitor.open")}
        onClick={() => {
          persistSidebarOpen(true);
          setOpen(true);
        }}
      />
    );
  }

  const live = win?.status === "live" && win.latest != null;
  return (
    <aside className="monitor-sidebar" data-testid="monitor-sidebar" aria-label={t("monitor.title")}>
      <div className="monitor-head">
        <span className="monitor-title">{t("monitor.title")}</span>
        <button
          className="monitor-close"
          data-testid="monitor-collapse"
          aria-label={t("monitor.close")}
          onClick={() => {
            persistSidebarOpen(false);
            setOpen(false);
          }}
        >
          ✕
        </button>
      </div>
      {live && win ? (
        <div className="monitor-body" data-testid="monitor-body">
          <MetricRow
            label={t("monitor.cpu")}
            value={`${win.latest!.cpu_percent.toFixed(0)}%`}
            values={win.cpu}
            max={100}
          />
          <MetricRow
            label={t("monitor.mem")}
            value={`${win.latest!.mem_used_percent.toFixed(0)}% · ${formatMemKB(win.latest!.mem_used_kb)}`}
            values={win.mem}
            max={100}
          />
          <MetricRow
            label={t("monitor.disk")}
            value={`${win.latest!.disk.length > 0 ? pickDiskOf(win).toFixed(0) : "0"}%`}
            values={win.disk}
            max={100}
          />
          <MetricRow
            label={t("monitor.load")}
            value={win.latest!.load_one.toFixed(2)}
            values={win.load1}
          />
          <MetricRow
            label={t("monitor.net")}
            value={`↓ ${formatRate(win.latest!.net_rx_bps)} ↑ ${formatRate(win.latest!.net_tx_bps)}`}
            values={win.netRx}
          />
        </div>
      ) : (
        <div className="monitor-body">
          <StatusFace status={win?.status ?? "idle"} enabled={enabled} />
        </div>
      )}
    </aside>
  );
}

/** 磁盘行口径与 store 一致（根挂载点优先）——直接复用窗口里已算好的序列尾值。 */
function pickDiskOf(win: MonitorWindow): number {
  return win.disk[win.disk.length - 1] ?? 0;
}
