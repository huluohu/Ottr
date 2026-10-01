// ProcessBrowser（Phase 3 Task 2，B4 下半）：per-session 远端进程浏览器。
// * 挂载位置选型（裁定「侧栏或独立面板」）：**主区视图切换第三视图**
//   （终端 | 文件 | 进程，FilePanel 同款挂点）——MonitorSidebar 已有五行
//   指标，进程表塞侧栏会挤占 sparkline 面；且进程浏览器是「宽表 + 逐行
//   动作」形态，主区横向空间充裕。FTP 会话无远端 shell，视图按钮隐藏。
// * 数据 = monitor_ps（只读 `ps -eo …--sort=-pcpu`，ottr-monitor::PS_CMD）；
//   面板挂载期间 5s 轮询 + 手动刷新；rustId 变化（重连/切标签）即重拉。
// * 表格排序：点击表头切换升/降（sortRows 纯函数；数值列数值比、文本列
//   localeCompare；同值按 pid 稳定序）；默认 CPU% 降序（服务端序的显式化）。
// * kill 流程（裁定：SIGTERM 默认；-9 二次确认）：行内「结束」→ 确认条
//   （SIGTERM 直确认；SIGKILL 按钮两段式——先武装再确认）→ 执行 → 刷新；
//   失败上屏（远端 stderr 原文——权限不足 EPERM 可见）。
// * 主题/i18n 纪律：色板走 App.css 令牌，文案全走 t()。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchProcesses, killProcess, type ProcEntry } from "./api";

export type ProcSortKey =
  | "pid"
  | "ppid"
  | "user"
  | "cpu_percent"
  | "mem_percent"
  | "etime_secs"
  | "comm";

/** 纯排序：数值列数值比、文本列 localeCompare；同值回退 pid 升序（稳定）。 */
export function sortRows(rows: ProcEntry[], key: ProcSortKey, dir: "asc" | "desc"): ProcEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    const cmp =
      typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
    return cmp !== 0 ? cmp * sign : a.pid - b.pid;
  });
}

const COLS: { key: ProcSortKey; labelKey: string }[] = [
  { key: "pid", labelKey: "process.colPid" },
  { key: "ppid", labelKey: "process.colPpid" },
  { key: "user", labelKey: "process.colUser" },
  { key: "cpu_percent", labelKey: "process.colCpu" },
  { key: "mem_percent", labelKey: "process.colMem" },
  { key: "etime_secs", labelKey: "process.colEtime" },
  { key: "comm", labelKey: "process.colComm" },
];

export function ProcessBrowser({ rustId }: { rustId: string | null }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ProcEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** 上屏错误（已翻译的展示文案；采集失败与 kill 失败共用一个错误面）。 */
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<ProcSortKey>("cpu_percent");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // kill 确认条状态：目标行 + SIGKILL 两段式（armed = 已点过一次，待确认）
  const [killTarget, setKillTarget] = useState<ProcEntry | null>(null);
  const [forceArmed, setForceArmed] = useState(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (rustId == null) return;
    const s = ++seq.current;
    try {
      const data = await fetchProcesses(rustId);
      if (s === seq.current) {
        setRows(data);
        setLoaded(true);
        setError(null);
      }
    } catch (err) {
      if (s === seq.current) {
        setLoaded(true);
        setError(t("process.loadFailed", { message: String(err) }));
      }
    }
  }, [rustId, t]);

  useEffect(() => {
    setRows([]);
    setLoaded(false);
    setError(null);
    setKillTarget(null);
    setForceArmed(false);
    if (rustId == null) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [rustId, refresh]);

  const sorted = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

  function toggleSort(key: ProcSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "comm" || key === "user" ? "asc" : "desc");
    }
  }

  function openKillConfirm(row: ProcEntry) {
    setKillTarget(row);
    setForceArmed(false);
  }

  async function doKill(force: boolean) {
    if (rustId == null || !killTarget) return;
    try {
      await killProcess(rustId, killTarget.pid, force);
      setKillTarget(null);
      setForceArmed(false);
      await refresh();
    } catch (err) {
      // 远端 stderr 原文直接上屏（EPERM 等失败可见）
      setError(t("process.killFailed", { message: String(err) }));
      setKillTarget(null);
      setForceArmed(false);
    }
  }

  return (
    <section className="proc-panel" data-testid="proc-panel" aria-label={t("process.title")}>
      <div className="proc-toolbar">
        <h3 className="proc-title">{t("process.title")}</h3>
        <span className="proc-count" data-testid="proc-count">
          {rows.length}
        </span>
        <span className="proc-toolbar-spacer" />
        <button data-testid="proc-refresh" aria-label={t("common.refresh")} onClick={() => void refresh()}>
          {t("common.refresh")}
        </button>
      </div>

      {rustId == null ? (
        <p className="proc-state" data-testid="proc-disconnected">
          {t("process.disconnected")}
        </p>
      ) : error != null ? (
        <p className="form-error" data-testid="proc-error">
          {error}
        </p>
      ) : !loaded ? (
        <p className="proc-state" data-testid="proc-loading">
          {t("common.loading")}
        </p>
      ) : sorted.length === 0 ? (
        <p className="proc-state" data-testid="proc-empty">
          {t("process.empty")}
        </p>
      ) : (
        <div className="proc-table-holder">
          <table className="proc-table" data-testid="proc-table">
            <thead>
              <tr>
                {COLS.map(({ key, labelKey }) => (
                  <th
                    key={key}
                    aria-sort={
                      sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : undefined
                    }
                  >
                    <button data-testid={`proc-sort-${key}`} onClick={() => toggleSort(key)}>
                      {t(labelKey)}
                      {sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                    </button>
                  </th>
                ))}
                <th aria-label={t("process.killTitle")} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.pid} data-testid={`proc-row-${row.pid}`}>
                  <td>{row.pid}</td>
                  <td>{row.ppid}</td>
                  <td>{row.user}</td>
                  <td>{row.cpu_percent.toFixed(1)}</td>
                  <td>{row.mem_percent.toFixed(1)}</td>
                  <td>{row.etime}</td>
                  <td className="proc-comm">{row.comm}</td>
                  <td>
                    <button
                      className="proc-kill-btn"
                      data-testid={`proc-kill-${row.pid}`}
                      onClick={() => openKillConfirm(row)}
                    >
                      {t("process.killButton")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {killTarget && (
        <div className="proc-confirm" data-testid="proc-kill-dialog" role="alertdialog">
          <p>{t("process.killConfirm", { pid: killTarget.pid, comm: killTarget.comm })}</p>
          <div className="proc-confirm-actions">
            <button data-testid="proc-kill-cancel" onClick={() => setKillTarget(null)}>
              {t("common.cancel")}
            </button>
            <button data-testid="proc-kill-confirm" onClick={() => void doKill(false)}>
              {t("process.killTerm")}
            </button>
            <button
              data-testid="proc-kill-force"
              data-armed={forceArmed}
              onClick={() => (forceArmed ? void doKill(true) : setForceArmed(true))}
            >
              {forceArmed ? t("process.killForceArmed") : t("process.killForce")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
