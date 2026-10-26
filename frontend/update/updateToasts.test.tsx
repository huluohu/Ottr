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

  it("检查出结果即收走「正在检查」toast（TTL 进度条不再空走，2026-10-13）", async () => {
    let resolveCheck!: (v: unknown) => void;
    checkMock.mockReturnValue(
      new Promise((r) => {
        resolveCheck = r;
      }),
    );
    runUpdateCheckToasts();
    expect(useToastStore.getState().toasts.some((t) => t.message.includes("Checking"))).toBe(
      true,
    );
    await act(async () => {
      resolveCheck(null);
    });
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.message.includes("up to date"))).toBe(
        true,
      ),
    );
    // 「正在检查」即刻消失：结果 toast 与它不再同屏共存
    expect(useToastStore.getState().toasts.some((t) => t.message.includes("Checking"))).toBe(
      false,
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

  it("下载中再点「检查更新」：就地报下载进度而非静默（2026-10-16 用户反馈）", () => {
    useUpdateStore.setState({
      phase: { kind: "downloading", received: 1024, total: 2048 },
    });
    runUpdateCheckToasts();
    // 单飞语义保持：不重复发起检查/下载，但必须有可感知的反馈
    expect(checkMock).not.toHaveBeenCalled();
    const msg = useToastStore.getState().toasts.map((t) => t.message).join("\n");
    expect(msg).toContain("Downloading");
    expect(msg).toContain("1/2");
  });

  it("下载中（未知总量）再点检查：提示正在下载而非静默", () => {
    useUpdateStore.setState({
      phase: { kind: "downloading", received: 512, total: null },
    });
    runUpdateCheckToasts();
    expect(checkMock).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.some((t) => t.message.includes("Downloading"))).toBe(
      true,
    );
  });

  it("检查中（他入口发起，如设置页）再点菜单检查：提示正在检查，不二次发起", () => {
    useUpdateStore.setState({ phase: { kind: "checking" } });
    runUpdateCheckToasts();
    expect(checkMock).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.some((t) => t.message.includes("Checking"))).toBe(true);
  });

  it("已装待重启再点「检查更新」：就地给「立即重启」toast，不再发起检查（2026-10-26：同一版本重查会被当新版本再报）", async () => {
    render(<Toaster />);
    const restart = vi.spyOn(useUpdateStore.getState(), "restartNow").mockImplementation(() => {});
    useUpdateStore.setState({ phase: { kind: "installed" }, info: { version: "1.0.0", date: null, body: null } });
    runUpdateCheckToasts();
    expect(checkMock).not.toHaveBeenCalled();
    const t = useToastStore.getState().toasts.find((x) => x.action);
    expect(t?.message).toMatch(/installed/i);
    fireEvent.click(await screen.findByTestId(`toast-action-${t!.id}`));
    expect(restart).toHaveBeenCalledTimes(1);
    // store 层同一护栏：installed 态 checkForUpdate 直接返回
    await useUpdateStore.getState().checkForUpdate();
    expect(checkMock).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().phase.kind).toBe("installed");
    restart.mockRestore();
  });

  it("发现新版把版本信息落 store.info（图标轨面板读）；下载失败保留 info 供轨上重试；已最新清空", async () => {
    checkMock.mockResolvedValue({
      ...fakeUpdate("0.9.1"),
      date: "2026-10-26T04:13:21Z",
      body: "## 0.9.1\n- x",
      downloadAndInstall: async () => {
        throw new Error("disk full");
      },
    });
    await useUpdateStore.getState().checkForUpdate();
    expect(useUpdateStore.getState().info).toEqual({
      version: "0.9.1",
      date: "2026-10-26T04:13:21Z",
      body: "## 0.9.1\n- x",
    });
    await useUpdateStore.getState().downloadAndInstall();
    expect(useUpdateStore.getState().phase).toEqual({ kind: "error", message: "disk full" });
    expect(useUpdateStore.getState().info?.version).toBe("0.9.1"); // 失败不丢提醒
    checkMock.mockResolvedValue(null);
    await useUpdateStore.getState().checkForUpdate();
    expect(useUpdateStore.getState().phase.kind).toBe("uptodate");
    expect(useUpdateStore.getState().info).toBeNull();
  });
});
