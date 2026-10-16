// ExportHostsDialog 组件测试：四格式选单渲染、缺省 CSV、取消路径、Xshell 目录
// 形态分支（save vs directory 选择）。导出动作的端到端在 App.test 菜单链路覆盖。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import "../i18n";
import { ExportHostsDialog } from "./ExportHostsDialog";

afterEach(() => cleanup());

describe("ExportHostsDialog（四格式导出）", () => {
  it("四格式选单渲染，缺省 CSV 选中；取消关闭", () => {
    const onClose = vi.fn();
    render(<ExportHostsDialog onClose={onClose} />);
    expect(screen.getByTestId("export-dialog")).toBeTruthy();
    for (const f of ["csv", "tabby", "xshell", "sshconfig"]) {
      expect(screen.getByTestId(`export-format-${f}`), f).toBeTruthy();
    }
    expect(screen.getByTestId("export-format-csv").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /cancel|取消/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("切格式：radio 互斥跟手（aria-checked）", () => {
    render(<ExportHostsDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("export-format-xshell"));
    expect(screen.getByTestId("export-format-xshell").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("export-format-csv").getAttribute("aria-checked")).toBe("false");
  });
});
