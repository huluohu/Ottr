// TransferQueue 渲染测试（feat/file-panel-enhancements）：下载完成条目的
// 「打开 / 在文件夹中显示」动作接线（opener 封装 mock，UI 逻辑与状态机分离）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// opener 封装单独 mock（真实现 dynamic import @tauri-apps/plugin-opener，
// jsdom 无 Tauri 运行时）；纯函数透传。
vi.mock("./api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./api")>();
  return {
    ...mod,
    openLocalFile: vi.fn().mockResolvedValue(undefined),
    revealLocalFile: vi.fn().mockResolvedValue(undefined),
  };
});

import "../i18n";
import { openLocalFile, revealLocalFile } from "./api";
import { TransferQueue } from "./TransferQueue";
import { useTransferStore, type TransferItem } from "./TransferStore";

const mockedOpen = vi.mocked(openLocalFile);
const mockedReveal = vi.mocked(revealLocalFile);

function makeItem(over: Partial<TransferItem>): TransferItem {
  return {
    transferId: "t1",
    kind: "download",
    remotePath: "/home/spike/d.zip",
    localPath: "/Users/me/Downloads/d.zip",
    rustId: "pty-0",
    total: 100,
    transferred: 100,
    status: "done",
    error: null,
    cancelling: false,
    startedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  mockedOpen.mockClear();
  mockedReveal.mockClear();
});

afterEach(() => {
  cleanup();
  useTransferStore.setState({ items: [] });
});

describe("TransferQueue 下载完成动作", () => {
  it("下载 done：打开 → openLocalFile(localPath)；在文件夹中显示 → revealLocalFile", () => {
    useTransferStore.setState({ items: [makeItem({})] });
    render(<TransferQueue />);
    fireEvent.click(screen.getByTestId("queue-open-t1"));
    expect(mockedOpen).toHaveBeenCalledWith("/Users/me/Downloads/d.zip");
    fireEvent.click(screen.getByTestId("queue-reveal-t1"));
    expect(mockedReveal).toHaveBeenCalledWith("/Users/me/Downloads/d.zip");
  });

  it("上传 done 不出现打开/显示动作；失败条目仍是重试/关闭", () => {
    useTransferStore.setState({
      items: [
        makeItem({ transferId: "t2", kind: "upload" }),
        makeItem({ transferId: "t3", status: "failed", error: "boom" }),
      ],
    });
    render(<TransferQueue />);
    expect(screen.queryByTestId("queue-open-t2")).toBeNull();
    expect(screen.queryByTestId("queue-reveal-t2")).toBeNull();
    expect(screen.getByTestId("queue-item-t3").getAttribute("data-status")).toBe("failed");
  });
});
