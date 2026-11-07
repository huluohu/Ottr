// 执行模式纯函数测试（Ask Ottr 第一步）：
//   * 模式归一：非法值一律回落 plan（**fail-safe**：绝不落到更宽松的档）；
//   * 计划步骤按「目标 + 命令」去重累积（2026-11-04 修补 B2：同一条命令在
//     不同目标下各自成步，同一目标下仍只留首次）；
//   * 新对话默认档走 localStorage（本机偏好，不入 vault/不同步）。
import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_DEFAULT_MODE_STORAGE_KEY,
  AI_EXEC_MODES,
  DEFAULT_AI_EXEC_MODE,
  awaitingPlanSteps,
  isAiExecMode,
  isAwaitingConfirmation,
  mergePlanSteps,
  mergeToolCallIds,
  needsModeUpgrade,
  normalizeAiExecMode,
  planStepKey,
  planStepsOf,
  planTargetKey,
  readDefaultAiExecMode,
  upsertPlanStep,
  writeDefaultAiExecMode,
  type PlanStep,
} from "./aiModes";

function step(id: string, command: string, target?: string): PlanStep {
  return { id, command, danger: "green", status: "planned", ...(target ? { target } : {}) };
}

beforeEach(() => {
  localStorage.clear();
});

describe("模式档位", () => {
  it("内部保留三档 plan / auto / manual；默认 manual（逐条确认，2026-11-07 用户反馈：不让用户切模式才能操作）", () => {
    expect([...AI_EXEC_MODES]).toEqual(["plan", "auto", "manual"]);
    expect(DEFAULT_AI_EXEC_MODE).toBe("manual");
  });

  it("isAiExecMode：只认三档", () => {
    expect(isAiExecMode("plan")).toBe(true);
    expect(isAiExecMode("manual")).toBe(true);
    expect(isAiExecMode("auto")).toBe(true);
    expect(isAiExecMode("yolo")).toBe(false);
    expect(isAiExecMode(null)).toBe(false);
  });

  it("normalizeAiExecMode：非法值回落 manual（逐条确认 = 每条都要用户授权，仍是 fail-safe）", () => {
    expect(normalizeAiExecMode("plan")).toBe("plan");
    expect(normalizeAiExecMode("manual")).toBe("manual");
    expect(normalizeAiExecMode("bogus")).toBe("manual");
    expect(normalizeAiExecMode(undefined)).toBe("manual");
    expect(normalizeAiExecMode(42)).toBe("manual");
  });
});

describe("计划步骤清单", () => {
  it("同命令去重（模型重提同一命令不重复列）", () => {
    const first = mergePlanSteps([], step("s1", "df -h"));
    const second = mergePlanSteps(first, step("s2", "df  -h")); // 空白差异 = 同一条
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("s1");
  });

  it("不同命令累积追加", () => {
    const a = mergePlanSteps([], step("s1", "df -h"));
    const b = mergePlanSteps(a, step("s2", "free -m"));
    expect(b.map((s) => s.command)).toEqual(["df -h", "free -m"]);
  });

  // 2026-11-04 修补 B2：去重键必须含**绑定目标**——同一条命令在不同终端 /
  // 不同连接上不是同一条步骤（否则用户看到的步骤归属错了目标）。
  it("同命令不同目标 → 两步都在（去重键含绑定目标）", () => {
    const a = mergePlanSteps([], step("s1", "df -h", "ssh:pty-a"));
    const b = mergePlanSteps(a, step("s2", "df -h", "ssh:pty-b"));
    expect(b).toHaveLength(2);
    expect(b.map((s) => s.target)).toEqual(["ssh:pty-a", "ssh:pty-b"]);
    // 同一目标下的同一条命令仍然只留首次（跨轮次合并去重不变）
    const c = mergePlanSteps(b, step("s3", "df  -h", "ssh:pty-a"));
    expect(c).toHaveLength(2);
    expect(c[0].id).toBe("s1");
  });

  it("planTargetKey：同一目标恒同键，连接换代（rustId 变）即换键", () => {
    expect(planTargetKey({ kind: "ssh", rustId: "pty-a" })).toBe(
      planTargetKey({ kind: "ssh", rustId: "pty-a" }),
    );
    expect(planTargetKey({ kind: "ssh", rustId: "pty-a" })).not.toBe(
      planTargetKey({ kind: "ssh", rustId: "pty-b" }),
    );
    expect(planTargetKey({ kind: "local", rustId: "pty-a" })).not.toBe(
      planTargetKey({ kind: "ssh", rustId: "pty-a" }),
    );
  });

  it("planStepKey：目标 + 命令（无目标 = 空键段）", () => {
    expect(planStepKey(step("s1", "df -h", "ssh:pty-a"))).toBe(
      planStepKey(step("s2", " df  -h ", "ssh:pty-a")),
    );
    expect(planStepKey(step("s1", "df -h", "ssh:pty-a"))).not.toBe(
      planStepKey(step("s2", "df -h", "ssh:pty-b")),
    );
    // 无目标的旧步骤与有目标的步骤不同键（不会互相吞掉）
    expect(planStepKey(step("s1", "df -h"))).not.toBe(
      planStepKey(step("s2", "df -h", "ssh:pty-a")),
    );
  });

  it("planStepsOf：缺省（字段未设 / null）返回空表", () => {
    expect(planStepsOf(null)).toEqual([]);
    expect(planStepsOf({})).toEqual([]);
    expect(planStepsOf({ plan: [step("s1", "ls")] })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 第二步（Manual 档）：步骤状态机 + 待答 tool call 合并 + 待处置判定
// ---------------------------------------------------------------------------

describe("Manual 档：步骤状态与合并", () => {
  it("状态集 = planned / executing / done / failed / rejected", () => {
    const s = step("s1", "df -h");
    expect(s.status).toBe("planned");
    // 状态是普通字符串联合——面板与 store 各自按值分派。
    const states: PlanStep["status"][] = ["planned", "executing", "done", "failed", "rejected"];
    expect(states).toHaveLength(5);
  });

  it("mergeToolCallIds：并集且保序去重", () => {
    expect(mergeToolCallIds(["c1"], ["c2"])).toEqual(["c1", "c2"]);
    expect(mergeToolCallIds(["c1", "c2"], ["c2"])).toEqual(["c1", "c2"]);
    expect(mergeToolCallIds(undefined, ["c1"])).toEqual(["c1"]);
    expect(mergeToolCallIds(undefined, undefined)).toEqual([]);
  });

  it("upsertPlanStep：同命令同目标且仍待处置 → 合并待答 call id", () => {
    const first = upsertPlanStep([], { ...step("s1", "df -h", "ssh:pty-a"), toolCallIds: ["c1"] });
    const second = upsertPlanStep(first, { ...step("s2", "df -h", "ssh:pty-a"), toolCallIds: ["c2"] });
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("s1");
    expect(second[0].toolCallIds).toEqual(["c1", "c2"]);
  });

  it("upsertPlanStep：已结清的步骤不再吞新调用（新的一步）", () => {
    const done = [{ ...step("s1", "df -h", "ssh:pty-a"), status: "done" as const }];
    const next = upsertPlanStep(done, { ...step("s2", "df -h", "ssh:pty-a"), toolCallIds: ["c2"] });
    expect(next).toHaveLength(2);
    expect(next[1].toolCallIds).toEqual(["c2"]);
  });

  it("isAwaitingConfirmation：只有挂着未答 tool call 的 planned 步骤算待处置", () => {
    expect(isAwaitingConfirmation({ ...step("s1", "df -h"), toolCallIds: ["c1"] })).toBe(true);
    // plan 档登记的步骤（没有待答 call id）不算待处置
    expect(isAwaitingConfirmation(step("s2", "df -h"))).toBe(false);
    // 已执行 / 已拒绝也不算
    expect(
      isAwaitingConfirmation({ ...step("s3", "df -h"), status: "done", toolCallIds: ["c1"] }),
    ).toBe(false);
  });

  it("awaitingPlanSteps：只挑出待处置的步骤", () => {
    const state = {
      plan: [
        { ...step("s1", "df -h"), toolCallIds: ["c1"] },
        step("s2", "free -m"),
        { ...step("s3", "uptime"), status: "rejected" as const, toolCallIds: ["c3"] },
      ],
    };
    expect(awaitingPlanSteps(state).map((s) => s.id)).toEqual(["s1"]);
    expect(awaitingPlanSteps(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 档位升级（plan 档登记 → manual 档）：判据只看**登记时的档位**
// ---------------------------------------------------------------------------

describe("档位升级判定", () => {
  it("manual 档登记的步骤 → 直路（不需升级）", () => {
    expect(needsModeUpgrade({ ...step("s1", "df -h"), registeredMode: "manual" })).toBe(false);
  });

  it("plan 档登记的步骤 → 需升级（先由后端升档再执行）", () => {
    expect(needsModeUpgrade({ ...step("s1", "df -h"), registeredMode: "plan" })).toBe(true);
  });

  it("缺省（字段未设）= plan → 需升级（fail-safe：宁可多一次登记）", () => {
    expect(needsModeUpgrade(step("s1", "df -h"))).toBe(true);
  });
});

describe("新对话默认执行模式（本机偏好）", () => {
  it("无存档 → manual；写入后可读回", () => {
    expect(readDefaultAiExecMode()).toBe("manual");
    writeDefaultAiExecMode("manual");
    expect(localStorage.getItem(AI_DEFAULT_MODE_STORAGE_KEY)).toBe("manual");
    expect(readDefaultAiExecMode()).toBe("manual");
  });

  it("存档被手改成非法值 → 回落 manual（逐条确认）", () => {
    localStorage.setItem(AI_DEFAULT_MODE_STORAGE_KEY, "yolo");
    expect(readDefaultAiExecMode()).toBe("manual");
  });
});
