// updateToasts 单测（2026-10-13 重构回归钉）：单飞防重（双份 toast 根因）/
// 发现新版 → toast 内「下载并安装」就地下载 / 完成提示。编排走真实
// updateStore + toastStore（集成面），仅 mock updater 插件的 check。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkMock = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...a: unknown[]) => checkMock(...a),
  // updateStore 仅作类型消费，运行时占位防 vi.mock 工厂缺绑定
  Update: class {},
}));

import "../i18n";
import { Toaster } from "../ui/Toaster";
import { useToastStore } from "../ui/toastStore";
import { useUpdateStore } from "./updateStore";
import { runUpdateCheckToasts } from "./updateToasts";

function fakeUpdate(version: string) {
  return {
    version,
    downloadAndInstall: async (cb?: (e: { event: string; data?: unknown }) => void) => {
      cb?.({ event: "Started", data: { contentLength: 2048 } });
      cb?.({ event: "Progress", data: { chunkLength: 1024 } });
      cb?.({ event: "Finished" });
    },
  };
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useUpdateStore.setState({ current: "0.9.0", portable: false, phase: { kind: "idle" } });
  checkMock.mockReset();
});

afterEach(() => cleanup());

describe("runUpdateCheckToasts（四端检查更新入口的 toast 编排）", () => {
  it("单飞：检查进行中重复触发不叠加 toast（双份「正在检查」回归钉）", async () => {
    let resolveCheck!: (v: unknown) => void;
    checkMock.mockReturnValue(
      new Promise((r) => {
        resolveCheck = r;
      }),
    );
    runUpdateCheckToasts();
    runUpdateCheckToasts(); // 连点第二次（旧实现：闭包旧 phase 护栏可穿）
    runUpdateCheckToasts(); // 第三次
    expect(useToastStore.getState().toasts).toHaveLength(1);

    await act(async () => {
      resolveCheck(null);
    });
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes("up to date"))).toBe(
        true,
      ),
    );
    // 单飞窗已关：再次触发是新的一次检查（新 checking toast）
    checkMock.mockResolvedValue(null);
    runUpdateCheckToasts();
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes("Checking"))).toBe(
        true,
      ),
    );
  });

  it("发现新版：单条 toast 内「下载 & 安装」按钮，点击就地下载（不再跳设置页）", async () => {
    render(<Toaster />);
    checkMock.mockResolvedValue(fakeUpdate("0.9.1"));
    runUpdateCheckToasts();
    await waitFor(() => expect(screen.getByTestId("toast-stack")).toBeTruthy());
    const actionToast = useToastStore.getState().toasts.find((t) => t.action);
    expect(actionToast).toBeTruthy();
    expect(actionToast?.message).toContain("v0.9.1");
    expect(actionToast?.action?.label).toBe("Download & install");

    // 只提示不自动下载（2026-10-10 裁定保持）：发现态无下载副作用
    expect(useUpdateStore.getState().phase.kind).toBe("available");

    fireEvent.click(screen.getByTestId(/toast-action-/));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes("Restart"))).toBe(
        true,
      ),
    );
    expect(useUpdateStore.getState().phase.kind).toBe("installed");
    // 安装完成 toast 带「立即重启」动作（2026-10-13：不再要求手动退出重开）
    const installedToast = useToastStore
      .getState()
      .toasts.find((t) => t.action?.label === "Restart Now");
    expect(installedToast?.message).toContain("Installed");
  });

  it("便携模式：四端入口就地一条手动更新指引，不发检查（2026-10-13）", async () => {
    render(<Toaster />);
    useUpdateStore.setState({ portable: true });
    checkMock.mockResolvedValue(null);
    runUpdateCheckToasts();
    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((t) => t.message.includes("portable")),
      ).toBe(true),
    );
    expect(checkMock).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().phase.kind).toBe("idle");
  });

  it("检查失败：错误原样入 toast", async () => {
    checkMock.mockRejectedValue(new Error("network down"));
    runUpdateCheckToasts();
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message === "network down")).toBe(true),
    );
  });
});
