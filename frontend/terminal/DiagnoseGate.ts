// DiagnoseGate（报错即诊的「取消宽限」面）：失败上报 → 弹诊断面板之间留一段
// 宽限期，用户在这段时间按 Ctrl+C 撤销（粘贴误执行、误触的长命令）→ 这次
// 诊断被收回，面板不弹。
//
// 为什么需要（2026-10-29 用户实测：「复制内容粘贴→点仍要粘贴→Ctrl+C 撤销→
// 弹了诊断」）：
// 诊断的触发源是**远端上报的退出码**（OSC 133 `D;<code>`），它比用户的按键早
// 一个网络往返——用户看到失败输出再按 Ctrl+C 撤销时，诊断早已触发完毕。远端
// 只知道自己失败了，不知道用户随后要撤销这次执行。
//
// 实测各 shell 在 Ctrl+C 时上报的退出码（pty 复现，Ubuntu 24.04 / macOS /
// Alpine）：
//   bash 4/5、zsh 5、dash、busybox ash → 130（SIGINT，语义准确；已被
//     shouldAutoDiagnose 排除）；
//   bash 3.2（macOS 自带）提示符层 Ctrl+C → **1**（不带 130）。
// 粘贴内容自身的失败（exit 1 / 127 / 2 …）一律会触发诊断——正是用户撤销的
// 那一类。
//
// 宽限期语义：
// * 失败上报 → 挂起（不立即弹面板）；
// * 宽限期内用户按 Ctrl+C → 收回（用户已明确放弃这次失败）；
// * 宽限期满 → 照常弹（用户没撤销，只是在继续干活）；
// * 卸载/会话结束 → 收回（面板不该在会话没了之后才弹）。
//
// 宽限期取 800ms：用户从「看到失败输出」到「按下 Ctrl+C」的反应时间
// （≈250–800ms）。期内用户改敲别的键不算撤销——撤销只由 Ctrl+C 表达。
import type { DiagnoseRequest } from "../ai/aiStore";

/** 默认宽限期（毫秒）。 */
export const DEFAULT_DIAGNOSE_GRACE_MS = 800;

export interface DiagnoseGateOptions {
  /** 宽限期毫秒数（失败上报 → 弹面板之间的等待）。 */
  graceMs?: number;
  /** 宽限期满、确认仍要诊断时的出口（打开面板）。 */
  onOpen: (req: DiagnoseRequest) => void;
}

/** 诊断取消宽限门：失败挂起 → Ctrl+C 收回 / 到期放行。 */
export class DiagnoseGate {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: DiagnoseRequest | null = null;
  private readonly graceMs: number;
  private readonly onOpen: (req: DiagnoseRequest) => void;

  constructor(options: DiagnoseGateOptions) {
    this.graceMs = options.graceMs ?? DEFAULT_DIAGNOSE_GRACE_MS;
    this.onOpen = options.onOpen;
  }

  /** 失败上报：挂起一个待弹诊断（新的挂起取代旧的——同一会话只留最近一次）。 */
  schedule(req: DiagnoseRequest): void {
    this.clearTimer();
    this.pending = req;
    this.timer = setTimeout(() => {
      this.timer = null;
      const r = this.pending;
      this.pending = null;
      if (r) this.onOpen(r);
    }, this.graceMs);
  }

  /** 用户按了 Ctrl+C：收回挂起的诊断（这次失败被用户撤销了）。 */
  cancel(): void {
    this.clearTimer();
    this.pending = null;
  }

  /** 卸载/会话结束：收回（面板不该在会话没了之后才弹）。 */
  dispose(): void {
    this.cancel();
  }

  /** 当前是否挂着待弹诊断（测试与调试用）。 */
  get isPending(): boolean {
    return this.pending !== null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
