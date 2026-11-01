// 全局焦点陷阱（2026-11-01 UI 审计 P1-4 回归）。
//
// 此前所有弹窗只声明 aria-modal="true"，没有任何实现——键盘 Tab 能从弹窗一路
// 走到背后的界面（锁屏时能 Tab 进仍可交互的应用本身）。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { useGlobalFocusTrap } from "./useFocusTrap";

/** 测试壳：挂一次全局陷阱 + 一个可开关的弹窗 + 背景里的按钮。 */
function Harness() {
  useGlobalFocusTrap();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button data-testid="bg-btn">背景按钮</button>
      <button data-testid="open-btn" onClick={() => setOpen(true)}>
        打开
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-label="测试弹窗" data-testid="dlg">
          <button data-testid="dlg-first">第一个</button>
          <button data-testid="dlg-last">最后一个</button>
        </div>
      )}
    </div>
  );
}

afterEach(cleanup);

describe("useGlobalFocusTrap", () => {
  it("弹窗出现时焦点进入弹窗", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("open-btn"));
    // MutationObserver → rAF 后聚焦；等一拍
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement?.getAttribute("data-testid")).toBe("dlg-first");
  });

  it("Tab 在弹窗内循环：最后一个再 Tab 回到第一个（不回背景）", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("open-btn"));
    await new Promise((r) => setTimeout(r, 30));
    screen.getByTestId("dlg-last").focus();
    // 焦点在最后一个时按 Tab → 应回到第一个（而不是跳到背景按钮）
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("dlg-first");
  });

  it("Shift+Tab 在第一个时回到最后一个", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("open-btn"));
    await new Promise((r) => setTimeout(r, 30));
    screen.getByTestId("dlg-first").focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("dlg-last");
  });

  it("焦点跑到弹窗外时按 Tab 被拉回弹窗", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("open-btn"));
    await new Promise((r) => setTimeout(r, 30));
    screen.getByTestId("bg-btn").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("dlg-first");
  });

  it("弹窗关闭后焦点还给触发者", async () => {
    render(<Harness />);
    const opener = screen.getByTestId("open-btn");
    opener.focus();
    fireEvent.click(opener);
    await new Promise((r) => setTimeout(r, 30));
    // 关闭弹窗
    const dlg = screen.getByTestId("dlg");
    dlg.remove();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement?.getAttribute("data-testid")).toBe("open-btn");
  });
});
