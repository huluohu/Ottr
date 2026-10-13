// 自动检查更新（2026-10-13 用户需求）：关闭 / 启动时检查 / 定时检查（24h）。
//
// 配置面 = vault settings `update.check_mode`（"off"（默认）| "startup" |
// "interval"），设置 → 关于 的下拉即改即生效（applyAutoCheckMode）。
//
// 自动检查的 UX 纪律（与手动 toast 流程的差异）：
//   * 全程静默——不弹「正在检查」、不报「已是最新」、出错不上屏（手动入口
//     才有完整反馈）；
//   * 唯一发声点 = 发现新版本（复用手动路径的「下载并安装」15s 决策窗
//     toast，绝不自动下载）；
//   * 便携版整体禁用（无安装器/无 updater 签名件，检查没有意义——与
//     设置面板/手动入口的隐藏同源）；非 Tauri 环境同样禁用。
//
// 单飞：复用 updateStore 的 phase 护栏（checking/downloading 期间跳过），
// 与手动入口互不打断（手动检查进行中时自动轮次让位）。
import i18n from "../i18n";
import { vaultApi } from "../vault/api";
import { showToast } from "../ui/toastStore";
import { useUpdateStore } from "./updateStore";

export type AutoCheckMode = "off" | "startup" | "interval";

export const SETTING_UPDATE_CHECK_MODE = "update.check_mode";
const INTERVAL_MS = 24 * 60 * 60 * 1000;

const MODES: readonly AutoCheckMode[] = ["off", "startup", "interval"];

export function parseMode(raw: string | null | undefined): AutoCheckMode {
  return MODES.includes(raw as AutoCheckMode) ? (raw as AutoCheckMode) : "off";
}

let intervalTimer: ReturnType<typeof setInterval> | undefined;
let started = false;

/** 读配置（vault settings；非 Tauri/未就绪 = off——不查是安全侧）。 */
async function readMode(): Promise<AutoCheckMode> {
  try {
    return parseMode(await vaultApi.settings.get<string>(SETTING_UPDATE_CHECK_MODE));
  } catch {
    return "off";
  }
}

/** 便携/非 Tauri 判定（app_portable；查询失败按 false——与 updateStore 口径一致）。 */
async function isPortable(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<boolean>("app_portable")) === true;
  } catch {
    return false;
  }
}

/** 一轮自动检查：便携/进行中让位；只有「发现新版本」发声（15s 决策窗）。 */
async function runSilentCheck(): Promise<void> {
  const st = useUpdateStore.getState();
  if (st.phase.kind === "checking" || st.phase.kind === "downloading") return;
  await st.checkForUpdate();
  const after = useUpdateStore.getState().phase;
  if (after.kind === "available") {
    const t = i18n.t.bind(i18n);
    showToast(t("update.available", { version: after.version }), "info", {
      label: t("update.downloadInstall"),
      // 与手动路径同一动作内核：toast 内点击 → 安静下载 → 完成带「立即重启」。
      run: () => {
        const unsub = useUpdateStore.subscribe((s) => {
          const k = s.phase.kind;
          if (k === "downloading") return;
          unsub();
          if (k === "installed") {
            showToast(t("update.installed"), "info", {
              label: t("update.restartNow"),
              run: () => useUpdateStore.getState().restartNow(),
            }, 15000);
          } else if (k === "error") {
            showToast(s.phase.message, "error");
          }
        });
        void useUpdateStore.getState().downloadAndInstall();
      },
    }, 15000);
  }
  // uptodate / error：自动路径保持静默（不打扰是本功能的全部意义）。
}

async function applyMode(mode: AutoCheckMode): Promise<void> {
  if (intervalTimer !== undefined) {
    clearInterval(intervalTimer);
    intervalTimer = undefined;
  }
  if (mode === "off") return;
  if (await isPortable()) return;
  // startup / interval 共有：启动即查一次。
  void runSilentCheck();
  if (mode === "interval") {
    intervalTimer = setInterval(() => void runSilentCheck(), INTERVAL_MS);
  }
}

/** App 挂载后调用一次（vault 就绪链上，读得到 settings 之后）。幂等。 */
export async function initAutoCheck(): Promise<void> {
  if (started) return;
  started = true;
  await applyMode(await readMode());
}

/** 设置页变更入口：落盘后的即时生效面（无需重启应用）。 */
export async function applyAutoCheckMode(mode: AutoCheckMode): Promise<void> {
  await applyMode(mode);
}

/** 测试专用：复位单次武装标记与计时器（生产代码勿调——App 只 init 一次）。 */
export function __resetForTests(): void {
  started = false;
  if (intervalTimer !== undefined) {
    clearInterval(intervalTimer);
    intervalTimer = undefined;
  }
}
