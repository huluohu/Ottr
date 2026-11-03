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
import i18n from "../i18n";

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; update: Update; version: string }
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "installed" }
  | { kind: "error"; message: string; detail?: string };

/** 把 updater/reqwest 的原始报错翻成「用户能据以行动的一句话」+ 排查细节。
 *
 * 原始报错形如 `error sending request for url (https://github.com/…/latest.json)`
 * ——直接展示等于把库名与内部 URL 甩到界面上，而且这条长串会把同行的
 * 「检查更新」按钮压变形（2026-11-03 用户实锤）。此处：
 *   * 正文 = 一句话说明（网络不通 / 清单缺失 / 签名不符 / 其它）；
 *   * 细节 = 原始串，只放进悬停提示（title），供排查用。
 */
function humanizeUpdateError(raw: string): { message: string; detail: string } {
  const t = i18n.t.bind(i18n);
  const lower = raw.toLowerCase();
  const pick = (
    network: string,
    manifest: string,
    signature: string,
    generic: string,
  ) => {
    if (/signature|invalid sign/.test(lower)) return signature;
    if (/404|not found|no such|release not found/.test(lower)) return manifest;
    if (
      /sending request|timed out|timeout|connect|dns|resolve|network|broken pipe|reset by peer/.test(
        lower,
      )
    ) {
      return network;
    }
    return generic;
  };
  return {
    message: pick(
      t("update.errorNetwork"),
      t("update.errorManifest"),
      t("update.errorSignature"),
      t("update.errorGeneric"),
    ),
    detail: raw,
  };
}

/** 是否属于「网络类」失败（值得自动重试一次）。 */
function isNetworkFailure(raw: string): boolean {
  const lower = raw.toLowerCase();
  return /sending request|timed out|timeout|connect|dns|resolve|network|broken pipe|reset by peer/.test(
    lower,
  );
}

/** 检查请求的总时限——插件的 reqwest **不设默认超时**，链路挂住时界面会一直
 * 停在「正在检查…」（用户看不到任何反馈）。 */
const CHECK_TIMEOUT_MS = 30_000;

/** 自动重试前的退避（毫秒）。 */
const AUTO_RETRY_DELAY_MS = 1_200;

/** 给 Promise 加时限（超时以 `update-timeout` 报错，便于与网络类错误同源处理）。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("update-timeout")), ms),
    ),
  ]);
}

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
  /** 自动重试计数（内部字段）：一轮失败最多自动重试一次，退避后复位。
   * 放 store 里而不是模块变量——测试可随 setState 一并复位。 */
  retryAttempt: number;
  /** 检查轮次令牌（内部字段）：超时后底层请求可能迟到返回，只认最后一次
   * 检查的结果。 */
  checkToken: number;
}

export const useUpdateStore = create<UpdateState>()((set, get) => {
  /** 真正跑一次检查（含自动重试）。
   *
   * 单独抽出来而不是复用 `checkForUpdate`：自动重试发生在 phase 仍是
   * `checking` 的时候，而 `checkForUpdate` 开头有幂等护栏（checking 直接
   * return）——复用会让重试被自己拦掉，永远重试不了（2026-11-03 自测
   * 抓到的自造 bug）。
   */
  const runCheck = async (): Promise<void> => {
    const token = get().checkToken + 1;
    set({ checkToken: token });
    try {
      const update = await withTimeout(check(), CHECK_TIMEOUT_MS);
      // 超时后底层请求可能迟到返回——只认最后一次检查的结果。
      if (get().checkToken !== token) return;
      if (update) {
        set({
          phase: { kind: "available", update, version: update.version },
          info: {
            version: update.version,
            date: update.date ?? null,
            body: update.body ?? null,
          },
          retryAttempt: 0,
        });
      } else {
        set({ phase: { kind: "uptodate" }, info: null, retryAttempt: 0 });
      }
    } catch (e) {
      if (get().checkToken !== token) return;
      const raw = e instanceof Error ? e.message : String(e);
      const { message, detail } = humanizeUpdateError(raw);
      // 网络类失败**自动重试一次**（退避 1.2s）：代理切换、GitHub 侧短暂
      // 不可达这类瞬时抖动，不该让用户手动再点一次（2026-11-03 用户反馈
      // 「第一次检测失败后再点也一直失败」）。非网络类失败（签名不符等）
      // 重试无意义，直接报错。
      //
      // **计数语义**：置 1 之后**不复位**——重试那一次看到 1 就不再重试，
      // 落到错误态时才复位（自测抓到的自造 bug：在重试回调里提前复位 →
      // 重试又看到 0 → 无限重试，错误态永远不出现）。
      if (isNetworkFailure(raw) && get().retryAttempt === 0) {
        set({ retryAttempt: 1 });
        setTimeout(() => {
          void runCheck();
        }, AUTO_RETRY_DELAY_MS);
        return;
      }
      set({ retryAttempt: 0 });
      set({ phase: { kind: "error", message, detail } });
    }
  };

  return {
    current: null,
    portable: null,
    phase: { kind: "idle" },
    info: null,
    retryAttempt: 0,
    checkToken: 0,
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
      if (
        p.kind === "checking" ||
        p.kind === "downloading" ||
        p.kind === "installed"
      )
        return; // 幂等
      set({ phase: { kind: "checking" } });
      await runCheck();
    },
    downloadAndInstall: async () => {
      const p = get().phase;
      if (p.kind !== "available") return;
      set({ phase: { kind: "downloading", received: 0, total: null } });
      try {
        await p.update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            set({
              phase: {
                kind: "downloading",
                received: 0,
                total: event.data.contentLength ?? null,
              },
            });
          } else if (event.event === "Progress") {
            set((s) =>
              s.phase.kind === "downloading"
                ? {
                    phase: {
                      kind: "downloading",
                      received: s.phase.received + event.data.chunkLength,
                      total: s.phase.total,
                    },
                  }
                : s,
            );
          } else if (event.event === "Finished") {
            set({ phase: { kind: "installed" } });
          }
        });
        set({ phase: { kind: "installed" } });
      } catch (e) {
        const { message, detail } = humanizeUpdateError(
          e instanceof Error ? e.message : String(e),
        );
        set({ phase: { kind: "error", message, detail } });
      }
    },
    restartNow: () => {
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("app_restart"))
        .catch(() => {});
    },
  };
});
