// OverviewPage（Phase 3 Task 2，B4 下半；UI 批次一 Task 3 迁主区视图）：
// 多主机总览。原「顶栏入口对话框」实体迁入 workspace/MainArea 的 overview
// 互斥视图（MainViewSlot 占位壳消亡）：挂载即打开、卸载即关闭，容器自
// overlay/dialog 换成主区充盈 section——卡片网格随主区宽度自适应列数
// （grid auto-fill minmax(280px,1fr)，宽屏列数更多）。逻辑面零改动。
// * 卡片网格 = 全部主机：monitor_enabled 主机实时卡（状态灯 + CPU/内存/磁盘
//   迷你指标条），未开启主机灰卡提示开启（裁定口径）；
// * 数据源 = useMonitorStore（rustId 分桶窗口，ottr://monitor 事件驱动、
//   打开即订阅零轮询）+ useSessionStore（host → 标签根会话 rustId 反查；
//   重连 = 新 rustId = 新窗口，与 Rust 采样任务同生命周期）；
// * 状态灯四态：live（绿）/ unsupported（黄，远端非 Linux）/ stopped（红，
//   采样终止）/ idle（灰，未连上或未采样）+ off（灰卡整体降级）；
// * 动作：点击卡片 → 跳转该主机终端标签（onOpen，MainArea 接线 = openTab +
//   openMainView("terminal")）；「进程」按钮 → 跳标签 + 切进程视图
//   （onOpenProcesses，SSH 会话可用）；
// * 一键开启监控（ui-batch2 T3，审计 A4）：未开启主机的灰卡直接放「开启监控」
//   按钮——替代「主机表单 → 监控面板」深路径。动作 = 既有 updateHost 全量替换
//   语义（HostInput 由 host 记录逐字段推导、只翻 monitor_enabled，HostForm
//   update 语义的轻量复用，零新增 store/api 面）；监控为 ssh 专属（采样随
//   ssh 会话启停），按钮只在 ssh + off 态卡片出现；在途禁用防双击双发。
// * 排序（sortForOverview 纯函数）：监控主机在前，组内按名称——总览的
//   视线优先级是「有数据的机器」；
// * 导航：头部「← 终端」返回按钮（承接原 MainViewSlot 的 slot-back-terminal
//   语义，onClose = openMainView("terminal") 由 MainArea 注入）；
// * 主题/i18n 纪律：色板走 App.css 令牌，文案全走 t()（零新增键）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { Host, HostInput } from "../vault/api";
import { useMonitorStore, pickDiskPercent, type MonitorWindow } from "./monitorStore";

export interface OverviewPageProps {
  /** 返回终端（MainArea 注入 = openMainView("terminal")）。 */
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

/** host 记录 → 全量替换式 HostInput（ui-batch2 T3 一键开启监控的推导面）：
 * 逐字段取自记录、over 只覆写开关类字段——与 HostForm update 提交的载荷形状
 * 同构（HostInput 无 created_at/updated_at，天然剥除）。 */
export function hostInputFrom(host: Host, over?: Partial<HostInput>): HostInput {
  return {
    name: host.name,
    group_id: host.group_id,
    tags: host.tags,
    address: host.address,
    port: host.port,
    username: host.username,
    protocol: host.protocol,
    credential_id: host.credential_id,
    jump_chain_id: host.jump_chain_id,
    encoding_override: host.encoding_override,
    theme_override: host.theme_override,
    monitor_enabled: host.monitor_enabled,
    is_production: host.is_production,
    notes: host.notes,
    ...over,
  };
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

export function OverviewPage({ onClose, onOpen, onOpenProcesses }: OverviewPageProps) {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);
  const sessions = useSessionStore((s) => s.sessions);
  const windows = useMonitorStore((s) => s.windows);
  const updateHost = useVaultStore((s) => s.updateHost);
  // 一键开启监控在途标记（hostId；在途禁用防双击双发——updateHost 全量替换
  // 语义下重复提交幂等但白耗一次 refresh 四连拉）。
  const [enablingId, setEnablingId] = useState<number | null>(null);

  async function enableMonitor(host: Host) {
    setEnablingId(host.id);
    try {
      await updateHost(host.id, hostInputFrom(host, { monitor_enabled: true }));
    } finally {
      setEnablingId(null);
    }
  }

  const rustByHost = rootRustIdByHost(sessions);
  const sorted = sortForOverview(hosts);

  // 主区视图容器（UI 批次一 Task 3）：挂载即打开（MainArea 路由互斥），
  // data-view 沿 MainViewSlot 槽位口径；返回按钮 testid 沿 slot-back-terminal。
  return (
    <section
      className="main-view overview-view"
      data-testid="overview-panel"
      data-view="overview"
      aria-label={t("overview.title")}
    >
      <div className="main-view-head">
        <h2>{t("overview.title")}</h2>
        <button data-testid="slot-back-terminal" onClick={onClose}>
          ← {t("files.viewTerminal")}
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
                  {/* 一键开启监控（ui2 T3，A4）：只在 ssh + off 态灰卡出现，
                      stopPropagation 防冒泡成卡片跳转；在途禁用。 */}
                  {light === "off" && (
                    <button
                      data-testid={`overview-monitor-on-${host.id}`}
                      disabled={enablingId === host.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void enableMonitor(host);
                      }}
                    >
                      {enablingId === host.id ? t("overview.enabling") : t("overview.enableMonitor")}
                    </button>
                  )}
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
    </section>
  );
}
