// 更新状态仓库（2026-10-10，自 UpdateCheck 组件抽取）：检查/下载/安装的
// 状态机单源——设置「关于」分区（完整进度 UX）与四端「检查更新」入口
// （mac 菜单/汉堡/⌘K/托盘 → toast 反馈）共用同一状态与动作。
//
// 反馈分工：设置分区渲染全部 phase（进度条/按钮/错误行）；四端入口由调用方
// 订阅 phase 变化转 toast（App update.check 分派），不打开任何页面。
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

interface UpdateState {
  current: string | null;
  phase: UpdatePhase;
  /** 拉当前版本号（非 Tauri 置 null）。 */
  loadCurrent: () => void;
  /** 检查更新（幂等：checking/downloading 期间重复调用忽略）。 */
  checkForUpdate: () => Promise<void>;
  /** 下载并安装（available 态消费）。 */
  downloadAndInstall: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  current: null,
  phase: { kind: "idle" },
  loadCurrent: () => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => set({ current: v }))
      .catch(() => set({ current: null }));
  },
  checkForUpdate: async () => {
    const p = get().phase;
    if (p.kind === "checking" || p.kind === "downloading") return; // 幂等
    set({ phase: { kind: "checking" } });
    try {
      const update = await check();
      set({ phase: update ? { kind: "available", update, version: update.version } : { kind: "uptodate" } });
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
}));
