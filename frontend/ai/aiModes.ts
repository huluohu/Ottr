// Ask Ottr 执行模式（第一步：Plan）——模式与计划步骤的类型/纯函数层。
//
// 为什么单独成模块：`mode`（会话级执行模式）与 `plan`（计划步骤清单）被
// 三处消费——store（状态与分派）、面板（渲染）、设置页（新对话默认档）。
// 三处各写一份字面量 = 三处迟早漂移；类型与默认值只此一处。
//
// 裁定（对齐 2026-11-04 第一步契约）：
// * 模式三档 plan / auto / manual，**默认 plan**（最安全：只产计划、绝不执行）；
// * 模式是**会话级**的：随对话保持，新对话复位到默认档；
// * auto = **自动档**（已落地，见下方「第三步」补记）；
// * 计划步骤按命令去重累积（同一对话多次提问 → 步骤清单合并，不重复列同一条）。
//
// 第二步（Manual 档）补记——**步骤带登记时的档位**（`PlanStep.registeredMode`）：
// 后端按登记簿里那条的档位判定执行权，plan 档登记的步骤调执行必被拒；手动档
// 的意义是「我来确认执行」，故用户在点「执行」的那一刻先让**后端**把同一条
// 命令以 manual 档**升档重登记**（新的 actionId；命令原文只从登记簿里取），
// 再执行升级后那条（见 aiStore）。
//
// 第三步（Auto 档）补记——自动档**已落地**，放行判定全在后端：
// * 主机被授权（授权表默认全拒）+ 命令在白名单/授权类别内 → **当场执行**
//   （后端登记一条 auto 档步骤并跑掉，回包 `executed:true` + 结果）；
// * 非白名单命令（逃逸形态 / 未知命令 / 未授权的写类别）→ **降级为逐条确认**
//   （后端按 **manual 档**登记，等用户点「执行」——降级不是失败，命令没跑）；
// * red 级命令 → 后端**直接拒**（零执行、零登记）；未授权的主机一律拒。
//
// **「用户已确认」是 UI 事实，后端无从核验**（设计取舍，见设计文档 §3.6 的
// 「不可承诺的边界」）：后端只保证「执行面按登记时落账的档位判定」。
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
 * 计划步骤状态。
 *
 * * `planned` —— 已登记、尚未执行（plan 档：永远停在这一态；manual 档与
 *   **自动档降级**下来的步骤：待用户点「执行」/「拒绝」）；
 * * `executing` —— 用户点了「执行」，命令真跑着（钮置灰）；
 * * `done` —— 命令跑完且退出码为 0（**含自动档当场执行**的那条）；
 * * `failed` —— 命令跑完但退出码非 0，或后端拒绝/执行异常；
 * * `rejected` —— 用户点了「拒绝」（命令没跑）。
 */
export type PlanStepStatus = "planned" | "executing" | "done" | "failed" | "rejected";

/**
 * 计划步骤的执行结果（第二步 Manual 模式：执行/失败后回填，面板就地展示）。
 *
 * `stdout` / `stderr` 是**面板展示用**的截断文本（完整文本走 tool 轮回灌给
 * 模型，不受这里的截断影响）；`truncated` 标记后端 64 KiB 上限的截断。
 */
export interface PlanStepResult {
  /** 退出码（null = 无退出码：被信号杀掉 / 超时等）。 */
  exitCode: number | null;
  /** 标准输出（展示用，已截断）。 */
  stdout: string;
  /** 错误输出（展示用，已截断）。 */
  stderr: string;
  /** 输出是否被后端截断。 */
  truncated: boolean;
  /**
   * **消费侧硬超时命中**（命令被中止、通道已显式关闭）。
   *
   * 单独一个布尔位：`exitCode === null` 单独看分不出「超时被中止」与
   * 「服务端没回退出码」——前者要给用户与模型**明确的超时提示**，后者
   * 只是「没有退出码」。故由后端直接给结论，前端不猜。
   */
  timedOut?: boolean;
  /** 后端拒绝/异常时的错误文案（失败原因；执行成功时为空）。 */
  error?: string;
}

export interface PlanStep {
  /**
   * 步骤 id（**清单里的行标识**：同一目标下同一条命令在清单里只占一行，
   * 合并时沿用首次登记的那条）。
   *
   * 它**不是**后端登记簿里那条的 stepId 本身——那条记在
   * {@link PlanStep.backendStepId}（两者只在**合并**之后分家：行标识保持
   * 稳定，登记事实跟着当前那次登记走）。
   */
  id: string;
  /**
   * **后端登记簿里那条的 stepId**（执行面按它取命令原文）。
   *
   * 缺省 = 用 {@link PlanStep.id}（没分家时两者同值）。分家只发生在**合并**
   * 上：同一目标同一条命令被重新登记时（跨轮次：上一轮规划登记 → 这一轮
   * 自动档当场执行 / 降级），清单里的**行**仍是一行，但登记事实必须换成
   * 新的（新的才是当前 scope 与当前登记事实）——而后端的 stepId 与
   * actionId 是**成对**的（stepId 由 actionId 派生），这一对必须同源。
   */
  backendStepId?: string;
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
  /** **登记该步骤的 scope id**（第二步 Manual 模式）：执行时用它调
   *  `ai_scope_run_step`——目标是登记时那台机器，不是当前焦点终端。 */
  scopeId?: string;
  /** **登记该步骤的一次性 action id**：执行时原样回传（后端按它防串改）。 */
  actionId?: string;
  /** 发起该步骤的模型 tool call id 集合（Manual 档登记时并入）。
   *  处置后按它回灌 tool 轮——同一命令被模型多次调用时，每个调用都要答上
   *  （provider 协议缺 tool 轮会 400）。plan 档登记的步骤没有这一项
   *  （那次调用当场就答过了）。 */
  toolCallIds?: string[];
  /** 登记该步骤的 run id（运行身份复核：被取代的链不得执行）。 */
  runId?: string;
  /**
   * **登记该步骤时的执行档位**（2026-11-04 修补：档位升级的前置事实）。
   *
   * 后端按**登记时落账的档位**判定执行权（`ai_scope_run_step` 复核登记簿里
   * 那一条的档位）：plan 档登记的步骤调执行必被拒「plan mode does not
   * execute」——手动档的意义就是「我来确认执行」，若不升级，用户在手动档点
   * 「执行」永远执行不了（荒谬的 UX 断裂）。
   *
   * 三档的实际口径：
   * * `plan` —— 只登记、绝不执行（后端在执行面直接拒）；
   * * `manual` —— **放行**（手动档登记的、以及**自动档降级**下来的步骤都是
   *   这一类——降级时后端就是按 manual 档登记的，用户点「执行」直接跑）；
   * * `auto` —— 登记时**后端已放行**（授权主机 + 白名单/授权类别）的那条
   *   才放行；后端当场执行走的是同一条执行路径。
   *
   * 缺省（字段未设）= **plan**（fail-safe：宁可多一次升档，也不越权执行）。
   */
  registeredMode?: AiExecMode;
  /** 执行结果（Manual 档执行/失败后回填；面板就地展示）。 */
  result?: PlanStepResult;
}

/**
 * 步骤是否**需要档位升级**才能执行（= 登记时不是 manual 档）。
 *
 * 判据只看**登记时的档位**（缺省 = plan）：plan 档登记的步骤在用户点「执行」
 * 之前，必须先由**后端**升档（`ai_scope_upgrade_step`：命令原文只从登记簿里
 * 取，前端不传命令；新 actionId 一次性），再执行升级后那条；manual 档登记
 * 的步骤直接执行（直路，不多一次调用）。
 *
 * 自动档两种登记都**不走**这条路：后端当场执行的那条已经是终态（done /
 * failed）；**降级**下来的那条后端就是按 **manual** 档登记的 → 直路。
 */
export function needsModeUpgrade(step: PlanStep): boolean {
  return (step.registeredMode ?? "plan") !== "manual";
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

/**
 * 待答的 tool call id 合并（第二步 Manual 模式）。
 *
 * 同一条命令被模型多次调用时，去重后只剩一个步骤，但**每次调用都要答上**
 * （provider 协议：assistant 的每个 tool_call 必须有对应 tool 消息，缺一个
 * 就 400）。这里做并集且保序去重。
 */
export function mergeToolCallIds(
  existing: string[] | undefined,
  incoming: string[] | undefined,
): string[] {
  const out: string[] = [];
  for (const id of [...(existing ?? []), ...(incoming ?? [])]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 步骤并入清单（第二步 Manual 模式口径 + 第三步自动档的语义分流）。
 *
 * 与 {@link mergePlanSteps} 的差别：
 * * 去重**只对仍待处置的步骤生效**（status === "planned"）——已执行/已拒绝
 *   的步骤是历史，同一条命令再被提一次 = **新的一步**（否则模型新发起的调用
 *   会挂在一个已结清的步骤上，那次 tool call 永远没人答）；
 * * 去重命中时**并入待答的 tool call id**（同一命令被多次调用 → 处置时一次
 *   答全，别漏答）。
 *
 * **自动档的分流**（2026-11-04 修补）：同一对话里可能**先在规划档登记过**
 * 一条命令、**后来在自动档又跑了 / 又降级了同一条**——两个条目会撞在同一个
 * 去重键（目标 + 命令）上。合并必须**按语义分流**，否则：
 * * 「已经跑过」的事实会被旧的「待执行」盖住（面板说待执行，命令其实早就
 *   跑过了）；
 * * 降级下来的步骤会沿用旧条目的登记档位（规划档）→ 自动档下**不给执行
 *   入口** → 降级成了死路。
 *
 * 三条分流规则：
 * 1. 新的条目**已跑完**（done / failed，自动档当场执行）→ **替换**旧的待
 *    执行条目（用新条目的 id / 状态 / 结果 / 登记事实）；
 * 2. 两边都是**待执行** → **合并成一行**（同一目标同一条命令不在清单里出现
 *    两行），登记事实（scopeId / actionId / registeredMode）取**新的**——
 *    新的才是当前 scope 与当前登记事实（旧的 scope 可能已被撤销）；
 * 3. 旧的条目**已定事实**（done / failed / rejected / executing）→ **不动
 *    它**，后到的条目另起一行（历史不覆盖）。
 */
export function upsertPlanStep(existing: PlanStep[] | undefined, step: PlanStep): PlanStep[] {
  const list = existing ?? [];
  const key = planStepKey(step);
  const idx = list.findIndex((s) => planStepKey(s) === key && s.status === "planned");
  if (idx < 0) return [...list, step];
  const prev = list[idx];
  const out = [...list];
  // 新条目在**后端登记簿里**的那条（缺省 = 它自己的 id——两者同值）。
  const registeredId = step.backendStepId ?? step.id;
  // ① 新的条目**已跑完**（自动档当场执行）→ 替换旧的待执行条目：面板上要
  //    显示「已自动执行」与结果，不是旧的「待执行」。
  if (step.status === "done" || step.status === "failed") {
    out[idx] = {
      ...step,
      backendStepId: registeredId,
      toolCallIds: mergeToolCallIds(prev.toolCallIds, step.toolCallIds),
    };
    return out;
  }
  // ② 两边都是待执行 → **合并成一行**（同一目标同一条命令不在清单里出现
  //    两行）：行标识沿用旧的，**登记事实取新的**（新的才是当前 scope 与
  //    当前登记事实——旧的 scope 可能已被撤销）。
  //
  //    注意 `backendStepId` 与 `actionId` 必须**同源**：后端的 stepId 是由
  //    actionId 派生的，两者成对——拿旧的 stepId 配新的 actionId，后端会拒
  //    「step … is not registered in this scope」/「actionId does not match
  //    the registered step」，那条降级步骤就又成了点不动的死路。
  out[idx] = {
    ...prev,
    ...step,
    // 行标识：沿用首次登记的那条（清单里这一行不换身份）。
    id: prev.id,
    // 登记事实：新的那条（scopeId / actionId / registeredMode 一起换）。
    backendStepId: registeredId,
    // 待答的 tool call id 取并集（两次登记都要答——provider 协议缺一条就 400）。
    toolCallIds: mergeToolCallIds(prev.toolCallIds, step.toolCallIds),
    // run id 取新的：登记时那条 run 才是这条步骤当下的归属（旧的 run 已被
    // 取代，带着它会让执行面的运行身份复验把这条步骤判成「不属于当前 run」）。
    runId: step.runId,
  };
  return out;
}

/**
 * 步骤是否**待用户处置**（Manual 档登记、尚未执行也未拒绝）。
 *
 * 判据 = 状态仍是 planned **且** 挂着未答的 tool call（toolCallIds 非空）——
 * plan 档登记的步骤没有 toolCallIds（那次调用当场答过），因此**不会**被误判
 * 成待处置（否则 plan 档会把追问输入永久禁掉）。
 */
export function isAwaitingConfirmation(step: PlanStep): boolean {
  return step.status === "planned" && (step.toolCallIds?.length ?? 0) > 0;
}

/** 待处置的步骤（会话切片里；plan 档恒为空）。 */
export function awaitingPlanSteps(
  state: { plan?: PlanStep[] } | null | undefined,
): PlanStep[] {
  return planStepsOf(state).filter(isAwaitingConfirmation);
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
