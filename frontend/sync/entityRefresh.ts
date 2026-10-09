// 同步导入落地后的本机实体刷新例程（BL-525 清偿，product-ready T6）。
//
// 问题：pull / 冲突裁定应用的 importCategories 是 **Rust 侧落库**（replace
// 语义），前端 zustand store 与全局单例仍持导入前内存态——侧栏主机列表/编辑
// 表单保存旧 port 或 stale id（保存被 Rust 拒「not found: host id=N」），
// 重启才恢复。清偿纪律：**复用既有 refresh 通道**（useVaultStore.refresh /
// useCronStore.refresh / useNotifyStore.bootstrap 的直接调用，同 App.tsx:286
// 先例），不开新事件路径。
//
// 八分类 → 持有方映射（survey 结论，未列分类无全局内存态）：
//   host_groups / credentials / hosts（含 jump_chains）
//     → useVaultStore.refresh()（**会上抛**——错误面对驱动源）；
//   cron_jobs      → useCronStore.refresh()（内部吞错，error 留面板展示）；
//   notify_channels→ remountChannels()（管线重挂载；内部吞错）+
//                    useNotifyStore.bootstrap()（muted_kinds 随 settings 类
//                    导入变化；内部吞错）；
//   alert_rules    → engine.reload()（评估管线装载；内部吞错）；
//   settings       → syncLangFromVault / syncThemeFromVault /
//                    useTerminalThemeStore.syncFromVault（三函数均已导出，
//                    App 就绪门同款调用；内部吞错，vault 为真源重读）；
//   snippets       → 无全局 store（BatchPanel 挂载时 vaultApi 直取，
//                    vault/store.ts「YAGNI」裁定）——无刷新通道可复用，面板
//                    重开即新读（残余面在 task-6-report §4 披露）。
//
// 失败语义：vault 主刷新失败 = 用户可见面（侧栏/表单）未对齐真源，**必须
// 上屏**——以本地化前缀包装原因原样上抛（SyncStore 在基线写盘前调用，基线
// 不写 → 下次三态判 push/conflict，可见非谎报 synced）。其余通道沿用各自
// 既定吞错纪律（store.error 面或 console.warn），防御性再包一层，任一失败
// 不阻断其余通道。
import i18n from "../i18n";
import { useVaultStore } from "../vault/store";
import { useCronStore } from "../cron/cronStore";
import { useNotifyStore } from "../notify/core";
import { remountChannels } from "../notify/channelRegistry";
import { engine } from "../notify/rules";
import { syncLangFromVault } from "../i18n";
import { syncThemeFromVault } from "../theme/ThemeContext";
import { useTerminalThemeStore } from "../theme/terminalThemeStore";

/** 吞错型通道的防御性包装：失败仅告警，不阻断其余刷新通道。 */
async function swallows(step: () => Promise<void>, label: string): Promise<void> {
  try {
    await step();
  } catch (e) {
    console.warn(`[sync-refresh] ${label} failed:`, e);
  }
}

/** importCategories 成功后调用（SyncStore onImported 注入点）。 */
export async function refreshEntitiesAfterImport(): Promise<void> {
  // 主刷新（唯一上抛通道）：hosts/credentials/host_groups/jump_chains 全局态。
  try {
    await useVaultStore.getState().refresh();
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`${i18n.t("sync.dialog.refreshFailed")}：${cause}`);
  }
  await swallows(() => useCronStore.getState().refresh(), "cron");
  await swallows(() => useNotifyStore.getState().bootstrap(), "notify");
  await swallows(() => remountChannels(), "channels");
  await swallows(() => engine.reload(), "alert-rules");
  await swallows(() => syncLangFromVault(), "language");
  await swallows(() => syncThemeFromVault(), "theme");
  await swallows(() => useTerminalThemeStore.getState().syncFromVault(), "terminal-theme");
}
