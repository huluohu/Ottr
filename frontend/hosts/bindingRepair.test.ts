// 凭据绑定修复提示（2026-11-03，v1.6.2 数据事故）：
// 有修复报告 → 告知用户恢复了多少台、还剩多少台要手动，并在提示后清空报告
// （修复器幂等，报告会一直留在库里；不清空则每次启动都弹同一句）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const settingsGet = vi.fn();
const settingsSet = vi.fn();

vi.mock("../vault/api", () => ({
  vaultApi: {
    settings: {
      get: (...a: unknown[]) => settingsGet(...a),
      set: (...a: unknown[]) => settingsSet(...a),
    },
  },
}));

import "../i18n";
import { announceBindingRepair, readBindingRepairReport } from "./bindingRepair";
import { useToastStore } from "../ui/toastStore";

beforeEach(() => {
  settingsGet.mockReset();
  settingsSet.mockReset();
  settingsSet.mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
});

describe("凭据绑定修复告知（v1.6.2 事故）", () => {
  it("没有报告 → 不弹提示", async () => {
    settingsGet.mockResolvedValue(null);
    await announceBindingRepair();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("有报告 → 弹一次提示，并清空报告（避免每次启动重复弹）", async () => {
    settingsGet.mockResolvedValue(
      JSON.stringify({
        restored: [{ host_id: 15, credential_id: 5, method: "cjk_substring" }],
        unmatched_hosts: [1, 2],
      }),
    );
    await announceBindingRepair();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain("1");
    expect(settingsSet).toHaveBeenCalledWith("repair.binding_report", "");
  });

  it("报告格式坏掉 → 不抛错、不提示", async () => {
    settingsGet.mockResolvedValue("{not json");
    await expect(announceBindingRepair()).resolves.toBeUndefined();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("readBindingRepairReport：解析出 restored / unmatched_hosts", async () => {
    settingsGet.mockResolvedValue(
      JSON.stringify({ restored: [], unmatched_hosts: [7] }),
    );
    const report = await readBindingRepairReport();
    expect(report?.unmatched_hosts).toEqual([7]);
  });
});
