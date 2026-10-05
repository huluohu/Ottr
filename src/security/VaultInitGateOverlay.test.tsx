// VaultInitGateOverlay 组件测试（BL-208 F3「就绪窗口键盘可达」，0×0 系终审C-16）：
// failed 态 = 模态 alertdialog + 退出按钮即聚焦（键盘用户零巡历到达唯一动作）；
// loading 态 = role=status 播报；ready 态不渲染。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import "../i18n";
import { VaultInitGateOverlay } from "./VaultInitGateOverlay";

afterEach(cleanup);

describe("VaultInitGateOverlay（BL-208 F3）", () => {
  it("loading：role=status，无可操作元素", () => {
    render(<VaultInitGateOverlay phase="initializing" error={null} />);
    expect(screen.getByTestId("vault-init-loading").getAttribute("role")).toBe("status");
    expect(screen.queryByTestId("vault-init-quit")).toBeNull();
  });

  it("failed：alertdialog + aria-modal，退出按钮挂载即聚焦（键盘可达）", () => {
    render(<VaultInitGateOverlay phase="failed" error="keychain denied" />);
    const overlay = screen.getByTestId("vault-init-failed");
    expect(overlay.getAttribute("role")).toBe("alertdialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("vault-init-error").textContent).toBe("keychain denied");
    const quit = screen.getByTestId("vault-init-quit");
    expect(document.activeElement).toBe(quit);
  });

  it("ready：不渲染任何遮罩", () => {
    render(<VaultInitGateOverlay phase="ready" error={null} />);
    expect(screen.queryByTestId("vault-init-loading")).toBeNull();
    expect(screen.queryByTestId("vault-init-failed")).toBeNull();
  });

  it("i18n：超时兜底文案键双语在位（F2 watchdog 消费面）", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf-8");
    for (const f of ["../i18n/zh-CN.json", "../i18n/en-US.json"]) {
      const dict = JSON.parse(read(new URL(f, import.meta.url).pathname)) as {
        security: { vaultInit: Record<string, string> };
      };
      expect(dict.security.vaultInit.timeout).toContain("{{seconds}}");
    }
  });
});
