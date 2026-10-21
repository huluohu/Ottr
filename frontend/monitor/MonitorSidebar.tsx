// MonitorPanel（原 MonitorSidebar）：监控视图内容组件。
// * 形态沿革：终端右栏折叠竖条（用户三次反馈被当成滚动条、压分屏钮）→
//   ToolDialog 内容 → 2026-10-17 满幅主区视图（会话子页签，与文件/进程同构；
//   侧栏定宽制式退役——右侧大片空黑 + 分屏钮遮挡，用户判词「简直是搞笑」）。
//   页签是唯一标题；本组件 = 指标卡网格 + 状态面 + 机制说明，页头由
//   WorkspaceViewShell 供给（MainArea 挂载）。
// * 数据源 = useMonitorStore（rustId 分桶；rustId 变化 = 重连，窗口重来）；
// * 状态面：未连接任何主机（disconnected）→ 说明前置条件；host 未开启监控
//   （off）→ 指引主机表单/总览；远端非 Linux（unsupported）→「不支持」；
//   采样终止（stopped）→ 提示重连。已连接且开启但无数据显示等待首采样；
//   采样机制说明（只读/间隔/仅 Linux）常驻视图底部；
// * 主题/i18n 纪律：色板走 App.css 令牌，文案全走 t()。
import { useTranslation } from "react-i18next";
import { Sparkline } from "./Sparkline";
import { useMonitorStore, type MonitorWindow } from "./monitorStore";

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

/** 指标卡：标签 + 当前值 + 全宽迷你图（SVG viewBox 缩放，卡宽自适应）。 */
function MetricCard({
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
    <div className="monitor-card" data-testid="monitor-metric">
      <div className="monitor-card-head">
        <span className="monitor-card-label">{label}</span>
        <span className="monitor-card-value" data-testid="monitor-metric-value">
          {value}
        </span>
      </div>
      <Sparkline values={values} max={max} label={label} width={280} height={56} />
    </div>
  );
}

/** 状态面（非 live 的五态文案）：unsupported/stopped 按 store 状态；未连接
 * （rustId = null）优先于未开启——「此主机未开启监控」对没连任何主机的场景
 * 是误导（2026-10-14 用户反馈「等待采样…看不懂」：空态必须说清前置条件）。
 * 已连接未开启 → off 指引；已连接已开启无数据 → 等待首采样。 */
function StatusFace({
  status,
  enabled,
  connected,
}: {
  status: MonitorWindow["status"];
  enabled: boolean;
  connected: boolean;
}) {
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
  if (!connected) {
    return (
      <p className="monitor-state" data-testid="monitor-disconnected">
        {t("monitor.disconnected")}
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

/** 视图内容（MainArea 经 WorkspaceViewShell 挂载；页签供给标题）。 */
export function MonitorPanel({
  rustId,
  enabled,
  local = false,
}: {
  /** 标签根会话的 Rust 会话 id（未连接 = null）。 */
  rustId: string | null;
  /** host.monitor_enabled（off 态指引的依据）；本地终端恒 true（连接即采样）。 */
  enabled: boolean;
  /** 本地终端会话：机制说明按本机口径（sysinfo，非远端 /proc）。 */
  local?: boolean;
}) {
  const { t } = useTranslation();
  const win = useMonitorStore((s) => (rustId ? s.windows[rustId] : undefined));

  const live = win?.status === "live" && win.latest != null;
  return (
    <div className="monitor-view" data-testid="monitor-panel" role="region" aria-label={t("monitor.title")}>
      {live && win ? (
        <div className="monitor-grid" data-testid="monitor-body">
          <MetricCard
            label={t("monitor.cpu")}
            value={`${win.latest!.cpu_percent.toFixed(0)}%`}
            values={win.cpu}
            max={100}
          />
          <MetricCard
            label={t("monitor.mem")}
            value={`${win.latest!.mem_used_percent.toFixed(0)}% · ${formatMemKB(win.latest!.mem_used_kb)}`}
            values={win.mem}
            max={100}
          />
          <MetricCard
            label={t("monitor.disk")}
            value={`${win.latest!.disk.length > 0 ? pickDiskOf(win).toFixed(0) : "0"}%`}
            values={win.disk}
            max={100}
          />
          <MetricCard
            label={t("monitor.load")}
            value={win.latest!.load_one.toFixed(2)}
            values={win.load1}
          />
          <MetricCard
            label={t("monitor.net")}
            value={`↓ ${formatRate(win.latest!.net_rx_bps)} ↑ ${formatRate(win.latest!.net_tx_bps)}`}
            values={win.netRx}
          />
        </div>
      ) : (
        <div className="monitor-status-card">
          <StatusFace status={win?.status ?? "idle"} enabled={enabled} connected={rustId !== null} />
        </div>
      )}
      {/* 机制说明常驻（2026-10-14 用户反馈「监控怎么用」）：采样口径一行说清。 */}
      <p className="monitor-state monitor-view-hint" data-testid="monitor-hint">
        {local ? t("monitor.localHint") : t("monitor.monitorHint")}
      </p>
    </div>
  );
}

/** 磁盘行口径与 store 一致（根挂载点优先）——直接复用窗口里已算好的序列尾值。 */
function pickDiskOf(win: MonitorWindow): number {
  return win.disk[win.disk.length - 1] ?? 0;
}
