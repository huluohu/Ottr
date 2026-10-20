// 全局剪贴板写入 + 自动清空（2026-10-20 用户裁定：「剪贴板自动清空」做成全局语义）。
//
// 背景：此前只有「复制凭据密码」（Rust 侧 vault_copy_credential_secret）带 30 秒
// 自动清空；终端选中复制、插件快捷命令、MCP 片段等都走 navigator.clipboard，
// 不清空——与设置项字面语义不符。本模块是所有**前端侧**剪贴板写入的唯一出口：
//   * 写剪贴板；
//   * 读配置 security.clipboard_clear_secs（缺省 30s，0 = 关，越界收敛）；
//   * 到点清空剪贴板（writeText("")），且只认「本应用最后一次复制」——
//     期间用户再次复制（任意入口）generation 自增，旧计时器让位。
//
// 已知边界（与 Rust 侧同款取舍，如实记录）：无法感知**其他应用**的复制——
// 若用户在 N 秒内从别的程序复制了内容，本计时器会把剪贴板清空。缓解方式是
// 清空前不读回校验（读剪贴板需要额外权限且会触发系统提示，得不偿失）；
// 默认 30 秒窗口较短，实际风险可接受。
import { invoke } from "@tauri-apps/api/core";
import { vaultApi } from "../vault/api";

/** 与 Rust settings.rs 同源缺省/上限（配置缺失或越界时收敛）。 */
export const CLIPBOARD_DEFAULT_SECS = 30;
export const CLIPBOARD_MAX_SECS = 3600;

/** 全局复制代数：只有最后一次写入的计时器有权清空。 */
let generation = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** 配置值 → 清空秒数（0/非法 = 不清空；越界收敛到上限）。纯函数，单测覆盖。 */
export function clipboardClearSecsFrom(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return CLIPBOARD_DEFAULT_SECS;
  const n = Math.floor(raw);
  if (n <= 0) return null;
  return Math.min(n, CLIPBOARD_MAX_SECS);
}

/** 写剪贴板并按配置调度自动清空。写入失败抛错（调用方决定提示与否）。 */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  generation += 1;
  const myGen = generation;
  // 旧计时器全部作废（后复制的不被先复制的计时器清掉）
  for (const [gen, timer] of timers) {
    clearTimeout(timer);
    timers.delete(gen);
  }
  let secs: number | null = CLIPBOARD_DEFAULT_SECS;
  try {
    secs = clipboardClearSecsFrom(
      await vaultApi.settings.get<number>("security.clipboard_clear_secs"),
    );
  } catch {
    secs = CLIPBOARD_DEFAULT_SECS; // 配置读不出 → 按默认保护
  }
  if (secs === null) return; // 关闭：不清空
  const timer = setTimeout(() => {
    timers.delete(myGen);
    if (generation !== myGen) return; // 期间有新复制：让位
    // 清空走 Rust（arboard）：WebKitGTK 下定时器里的 navigator.clipboard.
    // writeText("") 因缺用户激活被拒（2026-10-20 真机实测：5s 后仍可粘贴）；
    // 非 Tauri 环境（浏览器预览/测试）回退 navigator。
    void invoke("clipboard_clear").catch(() => {
      void navigator.clipboard?.writeText("").catch(() => {});
    });
  }, secs * 1000);
  timers.set(myGen, timer);
}

/** 测试隔离用（生产不调用）。 */
export function resetClipboardForTests(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  generation = 0;
}
