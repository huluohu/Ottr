// 四端「检查更新」入口的 toast 编排（2026-10-13 重构）：单飞 + 就地下载。
//
// 此前编排内联在 App.handleAction——防重护栏读闭包旧 phase（双击/连点即
// 穿透），每次调用各弹一套「正在检查」并各装一份 store 订阅 → toast 成对
// 出现（用户截图实锤）；且发现新版只有「到 设置 → 关于 下载安装」指引
// （用户裁定：跳设置页下载太扯）。
//
// 现为模块级单飞：flowActive 期间任何再触发（连点/多入口）静默忽略——
// 状态机仍是 update/updateStore 单源，本模块只做「phase → toast」的翻译：
//   检查中 → toast 一条；
//   已是最新 / 出错 → toast 结果；
//   发现新版 → toast 内「下载并安装」按钮（15s 决策窗；点击就地下载，
//   2026-10-10「绝不自动一条龙」裁定保持——下载仍须显式点击）→ 下载安静
//   （进度不逐条播报）→ 完成提示 toast 内「立即重启」（15s 决策窗；
//   2026-10-13 用户需求：安装完成不再要求手动退出重开）。
// 设置 → 关于 的 UpdateCheck 面板（完整进度 UX）不受影响，两者同源同状态。
import { showToast } from "../ui/toastStore";
import i18n from "../i18n";
import { useUpdateStore } from "./updateStore";

let flowActive = false;

/** 安装完成 toast（两处终态汇合：检查直达 / toast 内下载）统一带「立即重启」。 */
function installedToast(t: (key: string) => string): void {
  showToast(t("update.installed"), "info", {
    label: t("update.restartNow"),
    run: () => useUpdateStore.getState().restartNow(),
  }, 15000);
}

export function runUpdateCheckToasts(): void {
  if (flowActive) return; // 单飞：进行中的重复触发（连点/多入口）一律忽略
  const st = useUpdateStore.getState();
  if (st.phase.kind === "checking" || st.phase.kind === "downloading") return;
  flowActive = true;
  const t = i18n.t.bind(i18n);
  showToast(t("update.checking"), "info");
  const unsub = useUpdateStore.subscribe((s) => {
    const k = s.phase.kind;
    if (k === "checking") return;
    unsub();
    flowActive = false;
    if (k === "uptodate") {
      showToast(t("update.upToDate"), "info");
    } else if (k === "available") {
      showToast(t("update.available", { version: s.phase.version }), "info", {
        label: t("update.downloadInstall"),
        run: startInstallToasts,
      }, 15000);
    } else if (k === "installed") {
      installedToast(t);
    } else if (k === "error") {
      showToast(s.phase.message, "error");
    }
  });
  void st.checkForUpdate();
}

/** 「下载并安装」点击后：安静下载（进度不逐条播报），终态 toast 收尾。
 * 先订阅后触发——downloadAndInstall 入口同步置 downloading，不会漏终态。 */
function startInstallToasts(): void {
  const t = i18n.t.bind(i18n);
  const unsub = useUpdateStore.subscribe((s) => {
    const k = s.phase.kind;
    if (k === "downloading") return;
    unsub();
    if (k === "installed") installedToast(t);
    else if (k === "error") showToast(s.phase.message, "error");
  });
  void useUpdateStore.getState().downloadAndInstall();
}
