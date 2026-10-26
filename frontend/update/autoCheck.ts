// 自动检查更新（2026-10-13 用户需求）：关闭 / 启动时检查 / 定时检查（24h）。
//
// 配置面 = vault settings `update.check_mode`（"off"（默认）| "startup" |
// "interval"），设置 → 关于 的下拉即改即生效（applyAutoCheckMode）。
//
// 自动检查的 UX 纪律（与手动 toast 流程的差异）：
//   * **全程静默**——不弹「正在检查」、不报「已是最新」、出错不上屏；发现
//     新版本也不弹 toast（2026-10-26 用户裁定：图标轨更新钮是唯一提醒，
//     此前「toast + 轨上钮」一次发现两处提醒是重复——toast 只留给用户
//     主动点「检查更新」后的即时反馈）；
//   * 发现新版本的全部呈现 = updateStore.info 非空 → 图标轨更新钮浮现
//     （amber 呼吸点 + 贴钮面板「下载并安装」），绝不自动下载；
//   * 便携版整体禁用（无安装器/无 updater 签名件，检查没有意义——与
//     设置面板/手动入口的隐藏同源）；非 Tauri 环境同样禁用。
//
// 单飞：复用 updateStore 的 phase 护栏（checking/downloading/installed 期间
// 跳过），与手动入口互不打断（手动检查进行中时自动轮次让位）。
import { vaultApi } from "../vault/api";
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

/** 一轮自动检查：便携/进行中让位；结果只落 store（图标轨据 info 浮现更新钮）。 */
async function runSilentCheck(): Promise<void> {
  const st = useUpdateStore.getState();
  if (st.phase.kind === "checking" || st.phase.kind === "downloading" || st.phase.kind === "installed") return;
  await st.checkForUpdate();
  // available / uptodate / error：自动路径一律不上屏（不打扰是本功能的全部意义）。
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
