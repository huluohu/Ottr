// 更新状态仓库（2026-10-10，自 UpdateCheck 组件抽取）：检查/下载/安装的
// 状态机单源——设置「关于」分区（完整进度 UX）、四端「检查更新」入口
// （mac 菜单/汉堡/⌘K/托盘 → toast 反馈）与图标轨更新钮（2026-10-26 起贯穿
// 有新版→下载中→待重启全程的常驻指示 + 贴钮面板）共用同一状态与动作。
//
// 反馈分工：设置分区渲染全部 phase（进度条/按钮/错误行）；四端入口由调用方
// 订阅 phase 变化转 toast（App update.check 分派），不打开任何页面；图标轨
// 读 info（版本信息）决定钮的显隐与面板内容——自动检查发现新版本时**只亮
// 轨上钮不弹 toast**（2026-10-26 用户裁定：一次发现两处提醒是重复）。
import { check, Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; update: Update; version: string }
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "installed" }
  | { kind: "error"; message: string };

/** 新版本信息（图标轨面板展示面）：available 时自 Update 对象抽出，贯穿
 * downloading / installed / 下载失败——phase 一离开 available 就丢掉 Update
 * 对象，面板却要在全程显示「是哪个版本」。 */
export interface UpdateInfo {
  version: string;
  /** 发布时间（latest.json pub_date，RFC3339；缺省 null）。 */
  date: string | null;
  /** 发布说明（latest.json notes）。清单脚本自 1.5.9 起嵌入
   * docs/release-notes 正文；旧清单只有「Ottr x.y.z」一行。 */
  body: string | null;
}

interface UpdateState {
  current: string | null;
  /** 便携模式（exe 旁 portable.flag，2026-10-13 Windows 便携版；null = 未拉到）。
   * 便携版无安装器/updater 签名件——检查更新入口据此隐藏（更新 = 手动换包）。 */
  portable: boolean | null;
  phase: UpdatePhase;
  /** 待取/在途/已装的新版本信息；null = 没有待处理的更新（图标轨钮隐藏）。
   * 只在一次检查确认「已是最新」时清空——下载失败/重检失败都保留，用户
   * 还能从轨上钮重试，不会因一次网络抖动丢掉提醒。 */
  info: UpdateInfo | null;
  /** 拉当前版本号（非 Tauri 置 null）。 */
  loadCurrent: () => void;
  /** 检查更新（幂等：checking/downloading 期间重复调用忽略；installed 态
   * 同样忽略——已装待重启的更新再查一遍只会把同一版本当「新版本」再报）。 */
  checkForUpdate: () => Promise<void>;
  /** 下载并安装（available 态消费）。 */
  downloadAndInstall: () => Promise<void>;
  /** 立即重启（installed 态消费，2026-10-13）：Rust app_restart 走
   * AppHandle::restart——spawn 新实例后当前进程退出，invoke 永不 resolve
   * 是预期形态；非 Tauri 环境静默忽略。 */
  restartNow: () => void;
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  current: null,
  portable: null,
  phase: { kind: "idle" },
  info: null,
  loadCurrent: () => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => set({ current: v }))
      .catch(() => set({ current: null }));
    // 便携标记（Rust paths::app_portable）：非 Tauri = false（正常更新面）
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("app_portable"))
      .then((p) => set({ portable: p === true }))
      .catch(() => set({ portable: false }));
  },
  checkForUpdate: async () => {
    const p = get().phase;
    if (p.kind === "checking" || p.kind === "downloading" || p.kind === "installed") return; // 幂等
    set({ phase: { kind: "checking" } });
    try {
      const update = await check();
      if (update) {
        set({
          phase: { kind: "available", update, version: update.version },
          info: { version: update.version, date: update.date ?? null, body: update.body ?? null },
        });
      } else {
        set({ phase: { kind: "uptodate" }, info: null });
      }
    } catch (e) {
      set({ phase: { kind: "error", message: e instanceof Error ? e.message : String(e) } });
    }
  },
  downloadAndInstall: async () => {
    const p = get().phase;
    if (p.kind !== "available") return;
    set({ phase: { kind: "downloading", received: 0, total: null } });
    try {
      await p.update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          set({ phase: { kind: "downloading", received: 0, total: event.data.contentLength ?? null } });
        } else if (event.event === "Progress") {
          set((s) =>
            s.phase.kind === "downloading"
              ? { phase: { kind: "downloading", received: s.phase.received + event.data.chunkLength, total: s.phase.total } }
              : s,
          );
        } else if (event.event === "Finished") {
          set({ phase: { kind: "installed" } });
        }
      });
      set({ phase: { kind: "installed" } });
    } catch (e) {
      set({ phase: { kind: "error", message: e instanceof Error ? e.message : String(e) } });
    }
  },
  restartNow: () => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("app_restart"))
      .catch(() => {});
  },
}));
