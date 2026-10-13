// UpdateCheck 组件测试（2026-10-09 检查更新功能）：当前版本回显、已是最新、
// 发现新版 → 下载安装（进度事件 → 完成提示）。plugin-updater/api/app 全 mock
// （jsdom 无 Tauri runtime）；core.invoke mock 供便携标记（app_portable）用。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkMock = vi.fn();
const getVersionMock = vi.fn();
const invokeMock = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(() => checkMock()),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => getVersionMock()),
}));
// restartNow / app_portable 均经动态 import 取 core.invoke（jsdom 无 Tauri
// runtime，全 mock）
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import "../i18n";
import { UpdateCheck } from "./UpdateCheck";
import { useUpdateStore } from "./updateStore";

type UpdateEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

function makeUpdate(version: string, events: UpdateEvent[]) {
  return {
    version,
    downloadAndInstall: vi.fn(async (cb?: (e: UpdateEvent) => void) => {
      for (const e of events) cb?.(e);
    }),
  };
}

beforeEach(() => {
  checkMock.mockReset();
  getVersionMock.mockReset();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(false); // app_portable：默认安装版
  getVersionMock.mockResolvedValue("0.3.0");
  useUpdateStore.setState({ portable: null, phase: { kind: "idle" } });
});

afterEach(() => cleanup());

describe("UpdateCheck", () => {
  it("便携模式：检查按钮隐藏，就地显示手动更新指引（2026-10-13）", async () => {
    invokeMock.mockResolvedValue(true); // app_portable → true
    render(<UpdateCheck />);
    await waitFor(() => expect(screen.getByTestId("update-portable-hint")).toBeTruthy());
    expect(screen.queryByTestId("update-check-button")).toBeNull();
  });

  it("检查按钮渲染（v2：版本号由关于卡显示，本组件不再重复）", async () => {
    checkMock.mockResolvedValue(null);
    render(<UpdateCheck />);
    expect(screen.queryByTestId("update-current")).toBeNull();
    expect(screen.getByTestId("update-check-button")).toBeTruthy();
  });

  it("便携模式：指引 + 「打开下载页」直达 Releases 链接（2026-10-13）", async () => {
    invokeMock.mockResolvedValue(true); // app_portable → true
    render(<UpdateCheck />);
    const link = await waitFor(() => screen.getByTestId("update-portable-link"));
    expect(link.getAttribute("href")).toContain("releases/latest");
    expect(screen.queryByTestId("update-check-button")).toBeNull();
  });

  it("已是最新：check 返回 null → upToDate 提示", async () => {
    checkMock.mockResolvedValue(null);
    render(<UpdateCheck />);
    fireEvent.click(screen.getByTestId("update-check-button"));
    await waitFor(() => expect(screen.getByTestId("update-uptodate")).toBeTruthy());
  });

  it("发现新版 → 可用面板带版本号；安装走进度事件 → 完成提示", async () => {
    const update = makeUpdate("0.4.0", [
      { event: "Started", data: { contentLength: 2048 } },
      { event: "Progress", data: { chunkLength: 1024 } },
      { event: "Finished" },
    ]);
    checkMock.mockResolvedValue(update);
    render(<UpdateCheck />);
    fireEvent.click(screen.getByTestId("update-check-button"));
    const panel = await waitFor(() => screen.getByTestId("update-available"));
    expect(panel.textContent).toContain("0.4.0");
    fireEvent.click(screen.getByTestId("update-install"));
    await waitFor(() => expect(screen.getByTestId("update-installed")).toBeTruthy());
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("安装完成 → 「立即重启」按钮出现，点击走 app_restart（2026-10-13）", async () => {
    const update = makeUpdate("0.4.0", [
      { event: "Started", data: { contentLength: 1024 } },
      { event: "Finished" },
    ]);
    checkMock.mockResolvedValue(update);
    render(<UpdateCheck />);
    fireEvent.click(screen.getByTestId("update-check-button"));
    fireEvent.click(await waitFor(() => screen.getByTestId("update-install")));
    await waitFor(() => expect(screen.getByTestId("update-installed")).toBeTruthy());
    fireEvent.click(screen.getByTestId("update-restart"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("app_restart"));
  });

  it("检查失败：错误文本就地展示", async () => {
    checkMock.mockRejectedValue(new Error("network down"));
    render(<UpdateCheck />);
    fireEvent.click(screen.getByTestId("update-check-button"));
    await waitFor(() =>
      expect(screen.getByTestId("update-error").textContent).toContain("network down"),
    );
  });
});
