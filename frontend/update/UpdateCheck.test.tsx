// UpdateCheck 组件测试（2026-10-09 检查更新功能）：当前版本回显、已是最新、
// 发现新版 → 下载安装（进度事件 → 完成提示）。plugin-updater/api/app 全 mock
// （jsdom 无 Tauri runtime）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkMock = vi.fn();
const getVersionMock = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(() => checkMock()),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => getVersionMock()),
}));

import "../i18n";
import { UpdateCheck } from "./UpdateCheck";

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
  getVersionMock.mockResolvedValue("0.3.0");
});

afterEach(() => cleanup());

describe("UpdateCheck", () => {
  it("回显当前版本 + 检查按钮", async () => {
    checkMock.mockResolvedValue(null);
    render(<UpdateCheck />);
    await waitFor(() => expect(screen.getByTestId("update-current").textContent).toBe("0.3.0"));
    expect(screen.getByTestId("update-check-button")).toBeTruthy();
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

  it("检查失败：错误文本就地展示", async () => {
    checkMock.mockRejectedValue(new Error("network down"));
    render(<UpdateCheck />);
    fireEvent.click(screen.getByTestId("update-check-button"));
    await waitFor(() =>
      expect(screen.getByTestId("update-error").textContent).toContain("network down"),
    );
  });
});
