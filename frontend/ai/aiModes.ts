// Ask Ottr 执行模式（第一步：Plan）——模式与计划步骤的类型/纯函数层。
//
// 为什么单独成模块：`mode`（会话级执行模式）与 `plan`（计划步骤清单）被
// 三处消费——store（状态与分派）、面板（渲染）、设置页（新对话默认档）。
// 三处各写一份字面量 = 三处迟早漂移；类型与默认值只此一处。
//
// 裁定（对齐 2026-11-04 第一步契约）：
// * 模式三档 plan / auto / manual，**默认 plan**（最安全：只产计划、绝不执行）；
// * 模式是**会话级**的：随对话保持，新对话复位到默认档；
// * auto 本步尚未开放（主机授权表是第三步）——可选，但后端一律拒；
// * 计划步骤按命令去重累积（同一对话多次提问 → 步骤清单合并，不重复列同一条）。
import type { TrafficLight } from "./danger";

/** 会话级执行模式。 */
export type AiExecMode = "plan" | "auto" | "manual";

/** 全部模式档位（顺序 = 选择器展示顺序）。 */
export const AI_EXEC_MODES: readonly AiExecMode[] = ["plan", "auto", "manual"];

/** 默认档：规划（只产计划、不执行任何命令）。 */
export const DEFAULT_AI_EXEC_MODE: AiExecMode = "plan";

/** 是否是合法模式档位（外部读档/localStorage 校验用）。 */
export function isAiExecMode(v: unknown): v is AiExecMode {
  return typeof v === "string" && (AI_EXEC_MODES as readonly string[]).includes(v);
}

/** 归一：非法值一律回落默认档（plan）——**fail-safe**，绝不落到更宽松的档。 */
export function normalizeAiExecMode(v: unknown): AiExecMode {
  return isAiExecMode(v) ? v : DEFAULT_AI_EXEC_MODE;
}

/**
 * 计划步骤（第一步只有「已记入计划」一种状态；第二步接 Manual 时扩
 * pending/running/done/failed/rejected）。
 */
export type PlanStepStatus = "planned";

export interface PlanStep {
  /** 步骤 id（后端登记的 stepId；后端不可用时前端本地生成）。 */
  id: string;
  /** 命令原文（单行）。 */
  command: string;
  /** 目的说明（模型可在工具参数里给；缺省不展示）。 */
  purpose?: string;
  /** 危险等级（复用 danger.ts 的 classify() 分档——同一张规则表）。 */
  danger: TrafficLight;
  /** 步骤状态。 */
  status: PlanStepStatus;
  /** 绑定目标键（去重键的一半）：这条命令是给哪个目标开的——见
   *  {@link planTargetKey}。缺省 = 无目标（旧的/手工构造的步骤）。 */
  target?: string;
}

/** 命令归一（去空白 + 折叠内部空白）——去重比较用。 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * 绑定目标键（计划步骤去重键的一半）：**kind + rustId**——同一目标 = 同一
 * 键，连接换代（rustId 变）即换键。
 *
 * 为什么不用 scopeId：scope 是**每轮 run 现开**的（见 aiStore 的
 * openRunScope），拿 scopeId 当键会让「同一对话里的同一条命令」在追问轮
 * 变成两条步骤——与契约 §5「同一对话多次提问 → 步骤清单合并去重」相悖。
 * 为什么不用 paneSessionId：面板切片本身按 paneSessionId 分片，键里带上
 * 它没有信息量（真正区分「同一条命令属于谁」的是**运行时** rustId）。
 */
export function planTargetKey(target: { kind: string; rustId: string }): string {
  return `${target.kind}:${target.rustId}`;
}

/**
 * 步骤去重键 = **绑定目标 + 命令**（2026-11-04 修补 B2）。
 *
 * 原先只按命令去重 → 同一条命令在不同终端/不同连接上会被误并成一条
 * （用户看到的步骤归属错了目标）。加上目标键后：同一目标下的同一条命令
 * 仍只留首次（契约 §5 的跨轮次合并去重保持不变），**不同目标各自成步**。
 */
export function planStepKey(step: PlanStep): string {
  return `${step.target ?? ""}\u0000${normalizeCommand(step.command)}`;
}

/**
 * 步骤并入清单（**按「目标 + 命令」去重**）：同一条命令在同一目标下只留
 * 首次出现的那一步（后一次模型重提同一命令不重复列——清单是给人看的步骤，
 * 不是日志）；不同目标下的同一条命令**各自成步**。
 */
export function mergePlanSteps(existing: PlanStep[] | undefined, step: PlanStep): PlanStep[] {
  const list = existing ?? [];
  const key = planStepKey(step);
  if (list.some((s) => planStepKey(s) === key)) return list;
  return [...list, step];
}

/** 计划清单读取（缺省空表——字段可选，组件侧免 undefined 分支）。 */
export function planStepsOf(state: { plan?: PlanStep[] } | null | undefined): PlanStep[] {
  return state?.plan ?? [];
}

/** 步骤 id 生成（crypto.randomUUID 优先，计数器兜底）。 */
export function newPlanStepId(prefix = "plan"): string {
  const uniq =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Date.now() % 100000}`;
  return `${prefix}-${uniq}`;
}

/**
 * 「新对话默认执行模式」的存储口径：**本机偏好 → localStorage**，不入 vault。
 *
 * 为什么不做成 vault settings：默认档是**安全档位**（plan = 不执行），它随设备
 * 走会把一台机器的宽松选择带到另一台机器上；且 vault settings 键需在 Rust 侧
 * `validate_known_setting` 登记（枚举键），本步不碰 Rust。与 orb 位置
 * （ottr.askOrb.pos）同口径——本机偏好走 localStorage。
 */
export const AI_DEFAULT_MODE_STORAGE_KEY = "ottr.ai.defaultMode";

/** 读默认档（无存档/非法值 → plan）。 */
export function readDefaultAiExecMode(): AiExecMode {
  try {
    const raw = localStorage.getItem(AI_DEFAULT_MODE_STORAGE_KEY);
    if (raw === null) return DEFAULT_AI_EXEC_MODE;
    return normalizeAiExecMode(raw);
  } catch {
    return DEFAULT_AI_EXEC_MODE;
  }
}

/** 写默认档（写失败不阻塞——本次会话内仍按内存值走）。 */
export function writeDefaultAiExecMode(mode: AiExecMode): void {
  try {
    localStorage.setItem(AI_DEFAULT_MODE_STORAGE_KEY, mode);
  } catch {
    // 持久化失败不阻塞（隐私模式/配额满）
  }
}
