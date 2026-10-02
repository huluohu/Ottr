// OverviewPage（Phase 3 Task 2，B4 下半）：多主机总览（顶栏入口的对话框）。
// * 卡片网格 = 全部主机：monitor_enabled 主机实时卡（状态灯 + CPU/内存/磁盘
//   迷你指标条），未开启主机灰卡提示开启（裁定口径）；
// * 数据源 = useMonitorStore（rustId 分桶窗口，ottr://monitor 事件驱动、
//   打开即订阅零轮询）+ useSessionStore（host → 标签根会话 rustId 反查；
//   重连 = 新 rustId = 新窗口，与 Rust 采样任务同生命周期）；
// * 状态灯四态：live（绿）/ unsupported（黄，远端非 Linux）/ stopped（红，
//   采样终止）/ idle（灰，未连上或未采样）+ off（灰卡整体降级）；
// * 动作：点击卡片 → 跳转该主机终端标签（onOpen）；「进程」按钮 → 跳标签
//   + 切进程视图（onOpenProcesses，SSH 会话可用）；
// * 排序（sortForOverview 纯函数）：监控主机在前，组内按名称——总览的
//   视线优先级是「有数据的机器」；
// * 导航入口选型：顶栏按钮（ForwardPanel/JumpChainEditor 同款「全局面 →
//   顶栏对话框」布局语言；HostTree 顶部是主机管理动作区，不混全局视图）。
// * 主题/i18n 纪律：色板走 App.css 令牌，文案全走 t()。
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { Host } from "../vault/api";
import { useMonitorStore, pickDiskPercent, type MonitorWindow } from "./monitorStore";

export interface OverviewPageProps {
  open: boolean;
  onClose: () => void;
  /** 点击卡片：跳转该主机终端标签。 */
  onOpen: (host: Host) => void;
  /** 打开该主机终端标签并切到进程浏览器视图。 */
  onOpenProcesses: (host: Host) => void;
}

/** 总览状态灯档位（off = 未开启监控的灰卡；idle = 开了但当前无采样窗）。 */
export type OverviewLight = "live" | "unsupported" | "stopped" | "idle" | "off";

/** 灯位映射（纯函数）：未开启 → off；无窗口 → idle；否则窗口自身状态。 */
export function overviewLight(win: MonitorWindow | undefined, enabled: boolean): OverviewLight {
  if (!enabled) return "off";
  if (!win) return "idle";
  return win.status;
}

/** 总览排序（纯函数）：监控主机在前，组内按名称。 */
export function sortForOverview(hosts: Host[]): Host[] {
  return [...hosts].sort((a, b) => {
    if (a.monitor_enabled !== b.monitor_enabled) return a.monitor_enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** hostId → 标签根会话 rustId（未连接/连接中 = 无 rustId = 不在表）。 */
export function rootRustIdByHost(
  sessions: { hostId: number; rustId: string | null; paneOf: string | null }[],
): Map<number, string> {
  const map = new Map<number, string>();
  for (const s of sessions) {
    if (s.paneOf === null && s.rustId != null) map.set(s.hostId, s.rustId);
  }
  return map;
}

/** 迷你指标条：标签 + 占比条 + 数值（>85% 警示色）。 */
function MiniBar({ label, percent }: { label: string; percent: number }) {
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <div className="overview-metric" data-testid="overview-metric">
      <span className="overview-metric-label">{label}</span>
      <span className="overview-bar">
        <span
          className="overview-bar-fill"
          data-warn={pct >= 85}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="overview-metric-value">{pct.toFixed(0)}%</span>
    </div>
  );
}

export function OverviewPage({ open, onClose, onOpen, onOpenProcesses }: OverviewPageProps) {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);
  const sessions = useSessionStore((s) => s.sessions);
  const windows = useMonitorStore((s) => s.windows);

  if (!open) return null;

  const rustByHost = rootRustIdByHost(sessions);
  const sorted = sortForOverview(hosts);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("overview.title")}>
      <div className="dialog overview-panel" data-testid="overview-panel">
        <div className="dialog-head">
          <h2>{t("overview.title")}</h2>
          <button className="dialog-close" aria-label={t("common.close")} onClick={onClose}>
            ×
          </button>
        </div>

        {sorted.length === 0 && (
          <p className="overview-empty" data-testid="overview-empty">
            {t("overview.empty")}
          </p>
        )}

        <div className="overview-grid" data-testid="overview-grid">
          {sorted.map((host) => {
            const rustId = rustByHost.get(host.id) ?? null;
            const win = rustId != null ? windows[rustId] : undefined;
            const light = overviewLight(win, host.monitor_enabled);
            const live = win?.status === "live" && win.latest != null;
            return (
              <div
                key={host.id}
                className="overview-card"
                data-testid={`overview-card-${host.id}`}
                data-off={light === "off"}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(host)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpen(host);
                }}
              >
                <div className="overview-card-head">
                  <span
                    className="overview-light"
                    data-state={light}
                    aria-hidden="true"
                  />
                  <span className="overview-host">{host.name}</span>
                  <span className="overview-addr">
                    {host.username ? `${host.username}@` : ""}
                    {host.address}
                  </span>
                </div>
                {live && win ? (
                  <div className="overview-metrics">
                    <MiniBar label={t("monitor.cpu")} percent={win.latest!.cpu_percent} />
                    <MiniBar
                      label={t("monitor.mem")}
                      percent={win.latest!.mem_used_percent}
                    />
                    <MiniBar
                      label={t("monitor.disk")}
                      percent={pickDiskPercent(win.latest!)}
                    />
                  </div>
                ) : (
                  <p className="overview-state">
                    {light === "off"
                      ? t("overview.offHint")
                      : light === "idle"
                        ? t("overview.notConnected")
                        : light === "unsupported"
                          ? t("monitor.unsupported")
                          : t("monitor.stopped")}
                  </p>
                )}
                {host.protocol === "ssh" && (
                  <div className="overview-card-actions">
                    <button
                      data-testid={`overview-proc-${host.id}`}
                      disabled={rustId == null}
                      title={rustId == null ? t("overview.notConnected") : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenProcesses(host);
                      }}
                    >
                      {t("overview.procButton")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
