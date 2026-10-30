// 自动检查更新（2026-10-13 用户需求）：关闭 / 启动时检查 / 定时检查。
//
// 配置面 = vault settings `update.check_mode`：
//   * "off"（默认）/ "startup" —— 基础枚举；
//   * "interval" —— 旧值 = 24 小时档（2026-10-13 时只有这一档，向后兼容 ✓）；
//   * "interval:<小时>" —— **2026-10-29 用户需求：定时检查增加更密的挡位**
//     （1/3/8/15/24 小时；Rust 侧白名单同表，见 ottr-vault settings.rs）。
//
// 设置 → 关于 的下拉即改即生效（applyAutoCheckSetting）。
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

/** 定时检查的间隔挡位（小时）——与 Rust 侧 UPDATE_CHECK_INTERVAL_HOURS 对齐。 */
export const INTERVAL_HOURS = [1, 3, 8, 15, 24] as const;
export type IntervalHours = (typeof INTERVAL_HOURS)[number];
/** 裸值 "interval"（旧配置）对应的档位 = 24 小时。 */
export const DEFAULT_INTERVAL_HOURS: IntervalHours = 24;

/** 自动检查的完整设置（模式 + 间隔）。 */
export interface AutoCheckSetting {
  kind: AutoCheckMode;
  /** 定时检查的间隔小时数（kind==="interval" 时有效）。 */
  hours: IntervalHours;
}

/** 设置值 → 设置（非法值按 off 处理：安全侧不查）。 */
export function parseSetting(raw: string | null | undefined): AutoCheckSetting {
  if (raw === "startup") return { kind: "startup", hours: DEFAULT_INTERVAL_HOURS };
  if (raw === "interval") return { kind: "interval", hours: DEFAULT_INTERVAL_HOURS };
  if (typeof raw === "string" && raw.startsWith("interval:")) {
    const hours = Number(raw.slice("interval:".length));
    const hit = INTERVAL_HOURS.find((h) => Number(h) === hours);
    if (hit !== undefined) return { kind: "interval", hours: hit };
    return { kind: "off", hours: DEFAULT_INTERVAL_HOURS };
  }
  return { kind: "off", hours: DEFAULT_INTERVAL_HOURS };
}

/** 设置 → 设置值（24 小时档沿用裸 "interval"，避免旧配置被改写）。 */
export function encodeSetting(setting: AutoCheckSetting): string {
  if (setting.kind === "off") return "off";
  if (setting.kind === "startup") return "startup";
  return setting.hours === DEFAULT_INTERVAL_HOURS ? "interval" : `interval:${setting.hours}`;
}

let intervalTimer: ReturnType<typeof setInterval> | undefined;
let started = false;

/** 读配置（vault settings；非 Tauri/未就绪 = off——不查是安全侧）。 */
async function readSetting(): Promise<AutoCheckSetting> {
  try {
    return parseSetting(await vaultApi.settings.get<string>(SETTING_UPDATE_CHECK_MODE));
  } catch {
    return { kind: "off", hours: DEFAULT_INTERVAL_HOURS };
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

async function applySetting(setting: AutoCheckSetting): Promise<void> {
  if (intervalTimer !== undefined) {
    clearInterval(intervalTimer);
    intervalTimer = undefined;
  }
  if (setting.kind === "off") return;
  if (await isPortable()) return;
  // startup / interval 共有：启动即查一次。
  void runSilentCheck();
  if (setting.kind === "interval") {
    intervalTimer = setInterval(
      () => void runSilentCheck(),
      setting.hours * 60 * 60 * 1000,
    );
  }
}

/** App 挂载后调用一次（vault 就绪链上，读得到 settings 之后）。幂等。 */
export async function initAutoCheck(): Promise<void> {
  if (started) return;
  started = true;
  await applySetting(await readSetting());
}

/** 设置页变更入口：落盘后的即时生效面（无需重启应用）。 */
export async function applyAutoCheckSetting(setting: AutoCheckSetting): Promise<void> {
  await applySetting(setting);
}

/** 测试专用：复位单次武装标记与计时器（生产代码勿调——App 只 init 一次）。 */
export function __resetForTests(): void {
  started = false;
  if (intervalTimer !== undefined) {
    clearInterval(intervalTimer);
    intervalTimer = undefined;
  }
}
