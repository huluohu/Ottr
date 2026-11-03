// 凭据绑定修复提示（2026-11-03，v1.6.2 数据事故）。
//
// 事故：v1.6.2 的 0026 迁移重建 credentials 表时，hosts.credential_id 上的
// 外键 `ON DELETE SET NULL` 被触发 → 用户所有主机的凭据绑定被静默清空
// （升级后所有主机都连不上）。v1.6.3 起：
//   * 迁移期关闭外键强制 → 以后升级不再中招；
//   * 开库时按名称匹配把绑定找回来（Rust 侧修复器，逐条写审计表）。
//
// 本模块负责**告知用户**：恢复了哪几台、哪几台仍需手动绑 —— 不静默改数据。
import i18n from "../i18n";
import { vaultApi } from "../vault/api";
import { showToast } from "../ui/toastStore";
import { useVaultStore } from "../vault/store";

/** Rust 修复器写进 settings 的报告（键 `repair.binding_report`）。 */
export interface BindingRepairReport {
  /** 自动恢复的绑定。 */
  restored: { host_id: number; credential_id: number; method: string }[];
  /** 仍未绑定凭据、需用户手动处理的主机 id。 */
  unmatched_hosts: number[];
}

const REPORT_KEY = "repair.binding_report";

/** 读报告；没有报告（未中招 / 已确认过）→ null。 */
export async function readBindingRepairReport(): Promise<BindingRepairReport | null> {
  try {
    const raw = await vaultApi.settings.get<string>(REPORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BindingRepairReport;
    if (!parsed || !Array.isArray(parsed.restored)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 启动时提示一次：恢复了多少台、还剩哪几台要手动。 */
export async function announceBindingRepair(): Promise<void> {
  const report = await readBindingRepairReport();
  if (!report) return;
  const restored = report.restored.length;
  const pendingIds = report.unmatched_hosts;
  if (restored === 0 && pendingIds.length === 0) return;

  const t = i18n.t.bind(i18n);
  // 待处理主机要**点名**——只报数量用户不知道该去处理哪几台。
  const names = pendingIds
    .map((id) => useVaultStore.getState().hosts.find((h) => h.id === id)?.name)
    .filter((n): n is string => !!n);
  const pendingNames = names.length > 0 ? names.join("、") : String(pendingIds.length);

  const message =
    restored > 0
      ? t("hosts.bindingRepaired", { count: restored, pending: pendingNames })
      : t("hosts.bindingRepairPending", { count: pendingNames });
  // 长 TTL：这是一次性告知，用户可能过一会儿才看到主机列表。
  showToast(message, "info", undefined, 30_000);
  // 提示过即清空——否则每次启动都弹同一句（修复器幂等，报告会一直留在库里）。
  try {
    await vaultApi.settings.set(REPORT_KEY, "");
  } catch {
    // 写失败只导致下次再提示一次，不阻塞。
  }
}
