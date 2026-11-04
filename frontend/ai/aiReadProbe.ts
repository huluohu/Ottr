// AI 只读探查总开关（2026-11-04 修补 B3）：内建只读工具「读文件 / 列目录」
// 的**总闸**。
//
// 为什么单独成模块：开关的真源是**本机 localStorage**（照
// frontend/ai/orbStore.ts 的位置存法），**不落 vault**——vault settings 会
// 跨设备同步，把一台机器上的宽松选择带到另一台机器不是用户想要的（本机
// 偏好同口径）。本步只做一个总闸；「按主机授权表放开远端家目录之外的路径」
// 是第三步的事。
//
// 语义：
// * **默认开**（本步新开的只读面原本就默认开着；关掉是用户的显式选择）；
// * 关闭 → `ottr_read_file` / `ottr_list_dir` **不进 AI 工具目录**（模型根本
//   看不到这两个工具，不是"调了才被拒"）；其余工具（读输出尾 / 执行类 /
//   外部 MCP）**不受影响**；
// * 读档失败（隐私模式等）→ 回落默认开：关闭动作本身需要一次成功写入，
//   读不出说明用户从未成功关闭过（fail to the documented default）。

/** localStorage 键（本机 only，永不入 vault/不同步）。 */
export const AI_READ_PROBE_STORAGE_KEY = "ottr.ai.readProbe";

/** 读开关（无存档 → 默认开）。 */
export function readAiReadProbeEnabled(): boolean {
  try {
    const raw = localStorage.getItem(AI_READ_PROBE_STORAGE_KEY);
    if (raw === null) return true;
    return raw !== "off";
  } catch {
    return true;
  }
}

/** 写开关（本机 only；写失败不阻塞——本次会话内仍按内存值走）。 */
export function writeAiReadProbeEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AI_READ_PROBE_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // 持久化失败不阻塞（隐私模式/配额满）
  }
}
