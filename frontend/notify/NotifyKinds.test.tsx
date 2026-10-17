// NotifyKinds 组件测试（2026-10-17 通知类型区自通知中心迁设置→告警）：
// 勾选即写 settings（notify.muted_kinds）+ 入 muted 集；已静音 kind 勾选态回显。
// 原 NotificationCenter 侧同名用例随 UI 迁移（组件只渲染开关面，状态在
// useNotifyStore，管线入口消费）。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

afterEach(cleanup);

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { useNotifyStore } from "./core";
import { NotifyKindsSection } from "./NotifyKinds";

const mockedInvoke = invoke as unknown as Mock;

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async () => undefined);
  useNotifyStore.setState({ muted: [] });
});

describe("NotifyKinds（设置 → 告警 → 通知类型）", () => {
  it("六个可静音类别全渲染；已静音 kind 勾选态回显", () => {
    useNotifyStore.setState({ muted: ["session"] });
    render(<NotifyKindsSection />);
    const kinds = ["transfer", "session", "ai", "alert", "security", "cron"];
    for (const kind of kinds) {
      const box = screen.getByTestId(`notify-mute-${kind}`) as HTMLInputElement;
      expect(box.checked).toBe(kind === "session");
    }
  });

  it("勾选即写 settings 并入 muted 集（toggleMuted 走 store action）", async () => {
    useNotifyStore.setState({ muted: ["session"] });
    render(<NotifyKindsSection />);
    fireEvent.click(screen.getByTestId("notify-mute-transfer"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: "notify.muted_kinds",
        value: ["session", "transfer"],
      }),
    );
    expect(useNotifyStore.getState().muted).toEqual(["session", "transfer"]);
  });
});
