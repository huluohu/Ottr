// 四端「检查更新」入口的 toast 编排（2026-10-13 重构）：单飞 + 就地下载。
//
// 此前编排内联在 App.handleAction——防重护栏读闭包旧 phase（双击/连点即
// 穿透），每次调用各弹一套「正在检查」并各装一份 store 订阅 → toast 成对
// 出现（用户截图实锤）；且发现新版只有「到 设置 → 关于 下载安装」指引
// （用户裁定：跳设置页下载太扯）。
//
// 现为模块级单飞：flowActive 期间任何再触发（连点/多入口）静默忽略——
// 状态机仍是 update/updateStore 单源，本模块只做「phase → toast」的翻译：
//   检查中 → toast 一条（结果到达即收走——2026-10-13 用户反馈「都检查到
//   新版本了进度条还在走」：该 toast 的 TTL 进度条在结果出来后继续空走，
//   粗糙且误导，见 checkingToastId）；
//   已是最新 / 出错 → toast 结果；
//   发现新版 → toast 内「下载并安装」按钮（15s 决策窗；点击就地下载，
//   2026-10-10「绝不自动一条龙」裁定保持——下载仍须显式点击）→ 下载安静
//   （进度不逐条播报）→ 完成提示 toast 内「立即重启」（15s 决策窗；
//   2026-10-13 用户需求：安装完成不再要求手动退出重开）。
// 设置 → 关于 的 UpdateCheck 面板（完整进度 UX）不受影响，两者同源同状态。
import { showToast, updateToast, useToastStore } from "../ui/toastStore";
import i18n from "../i18n";
import { useUpdateStore } from "./updateStore";

let flowActive = false;

let availableToastId: number | null = null;

/** 「发现新版本」toast（手动/自动两条路径共用）：内嵌「下载并安装」，15s 决策窗。 */
function availableToast(version: string): void {
  const t = i18n.t.bind(i18n);
  // Otty 时刻④「更新就绪」（2026-10-16 M3）：冲浪板滑过顶沿——奖赏瞬间与
  // 决策窗同点触发；开关关/弱动效下 play 内部直接跳过。
  void import("../ui/otty/ottyStore").then(({ useOttyStore }) =>
    useOttyStore.getState().play("update"),
  );
  availableToastId = showToast(t("update.available", { version }), "info", {
    label: t("update.downloadInstall"),
    run: startInstallToasts,
  }, 15000);
}

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
  // 便携版（2026-10-13 Windows 便携版）：无 updater 签名件，检查没有意义——
  // 四端入口就地一条指引（与 设置→关于 面板的隐藏同源，updateStore.portable）。
  if (st.portable === true) {
    showToast(i18n.t("update.portableHint"), "info");
    return;
  }
  if (st.phase.kind === "checking" || st.phase.kind === "downloading") {
    // 进行中再触发：单飞语义保持（不重复发起），但不再静默（2026-10-16 用户
    // 反馈「下载中再点检查更新啥也不显示」——设置页发起的下载屏上没有进度
    // toast，此处是唯一反馈位）：就地报「正在检查/正在下载（含进度）」。
    const t = i18n.t.bind(i18n);
    if (st.phase.kind === "downloading" && st.phase.total != null && st.phase.total > 0) {
      showToast(
        t("update.downloadingOf", {
          received: Math.round(st.phase.received / 1024),
          total: Math.round(st.phase.total / 1024),
        }),
        "info",
      );
    } else {
      showToast(t(st.phase.kind === "checking" ? "update.checking" : "update.downloading"), "info");
    }
    return;
  }
  flowActive = true;
  const t = i18n.t.bind(i18n);
  const checkingToastId = showToast(t("update.checking"), "info");
  const unsub = useUpdateStore.subscribe((s) => {
    const k = s.phase.kind;
    if (k === "checking") return;
    unsub();
    flowActive = false;
    // 检查出结果的即刻收走「正在检查」——TTL 进度条不再空走（慢检查超过
    // 6s 时该 toast 已自愈消失，dismiss 幂等无害）。
    useToastStore.getState().dismiss(checkingToastId);
    if (k === "uptodate") {
      showToast(t("update.upToDate"), "info");
    } else if (k === "available") {
      availableToast(s.phase.version);
    } else if (k === "installed") {
      installedToast(t);
    } else if (k === "error") {
      showToast(s.phase.message, "error");
    }
  });
  void st.checkForUpdate();
}

/** 「下载并安装」点击后：收走决策窗 toast，改弹**下载进度 toast**并就地
 * 更新百分比（2026-10-14 用户反馈「点击下载后啥都没了，用户一片茫然」——
 * 旧的安静下载策略修正为可见进度），终态收尾 = 完成 toast 带「立即重启」。
 * 先订阅后触发——downloadAndInstall 入口同步置 downloading，不会漏终态。 */
export function startInstallToasts(): void {
  const t = i18n.t.bind(i18n);
  let downloadToastId: number | null = null;
  let lastPct = -5; // 节流：百分比每前进 ≥5% 才改写一次（避免逐 chunk 重渲染）
  const unsub = useUpdateStore.subscribe((s) => {
    const k = s.phase.kind;
    if (k === "downloading") {
      if (availableToastId != null) {
        useToastStore.getState().dismiss(availableToastId);
        availableToastId = null;
      }
      if (downloadToastId == null) {
        downloadToastId = showToast(t("update.downloading"), "info");
        lastPct = 0;
        return;
      }
      if (s.phase.total != null && s.phase.total > 0) {
        const pct = Math.floor((s.phase.received / s.phase.total) * 100);
        if (pct - lastPct >= 5) {
          lastPct = pct;
          updateToast(
            downloadToastId,
            t("update.downloadingOf", {
              received: Math.round(s.phase.received / 1024),
              total: Math.round(s.phase.total / 1024),
            }),
          );
        }
      }
      return;
    }
    // 终态：进度 toast 收走，结果发声
    if (downloadToastId != null) useToastStore.getState().dismiss(downloadToastId);
    unsub();
    if (k === "installed") installedToast(t);
    else if (k === "error") showToast(s.phase.message, "error");
  });
  void useUpdateStore.getState().downloadAndInstall();
}
