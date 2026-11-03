// updateStore 单测（2026-11-03 用户反馈「第一次检测失败后再点也一直失败」
// +「按钮都变形了」）：网络类失败自动重试一次 / 错误文案人话化 / 原始报错
// 不上屏（只进 detail，供悬停排查）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...a: unknown[]) => checkMock(...a),
  // updateStore 仅作类型消费，运行时占位防 vi.mock 工厂缺绑定
  Update: class {},
}));

import "../i18n";
import { useUpdateStore } from "./updateStore";

const NET_ERR =
  "error sending request for url (https://github.com/huluohu/Ottr/releases/latest/download/latest.json)";

beforeEach(() => {
  checkMock.mockReset();
  useUpdateStore.setState({
    current: "1.0.0",
    portable: false,
    phase: { kind: "idle" },
    info: null,
    retryAttempt: 0,
  });
});

/** 等到 phase 变成期望的 kind（自动重试有 1.2s 退避）。 */
async function waitPhase(kind: string, timeout = 5000): Promise<void> {
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() => expect(useUpdateStore.getState().phase.kind).toBe(kind), {
    timeout,
  });
}

describe("updateStore 的检查更新（2026-11-03 修复）", () => {
  it("网络类失败：自动重试一次，重试成功即不报错", async () => {
    checkMock.mockRejectedValueOnce(new Error(NET_ERR));
    checkMock.mockResolvedValueOnce(null);
    await useUpdateStore.getState().checkForUpdate();
    await waitPhase("uptodate");
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it("网络类失败两次：落到错误态——正文是人话，原始报错只在 detail 里", async () => {
    checkMock.mockRejectedValue(new Error(NET_ERR));
    await useUpdateStore.getState().checkForUpdate();
    await waitPhase("error");
    const phase = useUpdateStore.getState().phase as {
      kind: "error";
      message: string;
      detail?: string;
    };
    expect(phase.message).not.toContain("error sending request");
    expect(phase.message).not.toContain("github.com");
    expect(phase.detail).toContain("error sending request");
    // 只重试一次（不无限重试）。
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it("非网络类失败（签名不符）：不重试，直接报错", async () => {
    checkMock.mockRejectedValue(new Error("invalid signature"));
    await useUpdateStore.getState().checkForUpdate();
    await waitPhase("error");
    expect(checkMock).toHaveBeenCalledTimes(1);
    const phase = useUpdateStore.getState().phase as {
      kind: "error";
      message: string;
    };
    expect(phase.message).not.toContain("invalid signature");
  });

  it("清单缺失（404）：不重试（重试无意义），文案说清单没找到", async () => {
    checkMock.mockRejectedValue(
      new Error("the remote server responded with 404 Not Found"),
    );
    await useUpdateStore.getState().checkForUpdate();
    await waitPhase("error");
    expect(checkMock).toHaveBeenCalledTimes(1);
    const phase = useUpdateStore.getState().phase as {
      kind: "error";
      message: string;
    };
    expect(phase.message.toLowerCase()).toContain("manifest");
  });
});
