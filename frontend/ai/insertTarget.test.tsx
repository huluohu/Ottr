// 插入目标隔离组件测试（ask-ottr-orb Task 3）：
//   * CodeBlockRow 接收 run 的插入绑定（target + scopeId + runId + blockIndex），
//     生产插入走 ai_scope_insert（一次性 actionId = `${runId}:${blockIndex}`）；
//   * R2：当前聚焦 pane ≠ 绑定 pane → 插入禁用（注入的测试插入器也绕不过
//     生产守卫）+ 「回到原终端」affordance，绝不静默改插当前终端；
//   * 绑定变化（scope 换新/目标换代）→ remount → 确认状态机复位（armed 不跨绑定）。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { CodeBlockRow, defaultScopeInserter, type InsertTarget, type ScopeInserter } from "./InsertRow";
import { useSessionStore, type Session } from "../session/SessionStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("zh-CN");
  useSessionStore.setState({ sessions: [], activeId: null, activePane: {} });
});

const TARGET_A: InsertTarget["target"] = {
  paneSessionId: "pane-a",
  rootTabId: "tab-1",
  rustId: "pty-a",
  connectionEpoch: 1,
  kind: "ssh",
  hostId: 7,
};
const BINDING_A: InsertTarget = { target: TARGET_A, scopeId: "scope-1", runId: "run-1", blockIndex: 0 };

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: "pane-a",
    hostId: 7,
    hostName: "web-01",
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: "pty-a",
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    isProduction: false,
    connectionEpoch: 1,
    ...over,
  };
}

function seedFocus(focusedPane: string): void {
  useSessionStore.setState({
    sessions: [
      fakeSession({ id: "pane-a", paneOf: "tab-1" }),
      fakeSession({ id: "pane-b", paneOf: "tab-1", rustId: "pty-b" }),
    ],
    activeId: "tab-1",
    activePane: { "tab-1": focusedPane },
  });
}

it("R2：聚焦 pane ≠ 绑定 pane → 禁用 + 提示 + 回到原终端；注入的插入器不被调用", () => {
  seedFocus("pane-b"); // 生成于 A，此刻聚焦 B
  const scopeInserter: ScopeInserter = vi.fn().mockResolvedValue(undefined);
  render(<CodeBlockRow code="df -h" rustId={null} inserter={vi.fn()} insertTarget={BINDING_A} scopeInserter={scopeInserter} />);
  const button = screen.getByTestId("ai-insert") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(scopeInserter).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  // 提示与回原终端 affordance
  expect(screen.getByTestId("ai-insert-wrong-target")).toBeTruthy();
  expect(screen.getByTestId("ai-return-to-original").textContent).toContain("原终端");
});

it("R2：「回到原终端」把聚焦 pane 切回绑定 pane，此后可正常插入", () => {
  seedFocus("pane-b");
  const scopeInserter: ScopeInserter = vi.fn().mockResolvedValue(undefined);
  render(<CodeBlockRow code="df -h" rustId={null} inserter={vi.fn()} insertTarget={BINDING_A} scopeInserter={scopeInserter} />);
  fireEvent.click(screen.getByTestId("ai-return-to-original"));
  const st = useSessionStore.getState();
  expect(st.activeId).toBe("tab-1");
  expect(st.activePane["tab-1"]).toBe("pane-a");
});

it("R2：聚焦 pane = 绑定 pane → 走 scope 通道插入（actionId = runId:blockIndex，无换行）", async () => {
  seedFocus("pane-a");
  render(<CodeBlockRow code="df -h" rustId={null} inserter={vi.fn()} insertTarget={BINDING_A} />);
  const button = screen.getByTestId("ai-insert") as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await vi.waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("ai_scope_insert", {
      scopeId: "scope-1",
      actionId: "run-1:0",
      text: "df -h",
    });
  });
});

it("defaultScopeInserter：多行/控制字符拒绝（与 write_session 通道同一守卫）", async () => {
  await expect(defaultScopeInserter(BINDING_A, "echo one\necho two")).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  await expect(defaultScopeInserter(BINDING_A, "echo ok")).resolves.toBeUndefined();
  expect(invoke).toHaveBeenCalledWith("ai_scope_insert", {
    scopeId: "scope-1",
    actionId: "run-1:0",
    text: "echo ok",
  });
});

it("危险命令（yellow）第二击才插；绑定换新（scopeId 变）→ 确认复位不跨绑定", async () => {
  seedFocus("pane-a");
  const scopeInserter: ScopeInserter = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <CodeBlockRow code="sudo reboot" rustId={null} inserter={vi.fn()} insertTarget={BINDING_A} scopeInserter={scopeInserter} />,
  );
  fireEvent.click(screen.getByTestId("ai-insert"));
  expect(scopeInserter).not.toHaveBeenCalled();
  expect(screen.getByTestId("ai-insert").getAttribute("data-stage")).toBe("confirm");
  // 换绑定（新 run 新 scope）：remount → 状态机复位
  view.rerender(
    <CodeBlockRow
      code="sudo reboot"
      rustId={null}
      inserter={vi.fn()}
      insertTarget={{ ...BINDING_A, scopeId: "scope-2", runId: "run-2" }}
      scopeInserter={scopeInserter}
    />,
  );
  expect(screen.getByTestId("ai-insert").getAttribute("data-stage")).toBe("idle");
  fireEvent.click(screen.getByTestId("ai-insert")); // 复位后第一击只确认
  expect(scopeInserter).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("ai-insert")); // 第二击才插
  await vi.waitFor(() => {
    expect(scopeInserter).toHaveBeenCalledWith(
      { target: TARGET_A, scopeId: "scope-2", runId: "run-2", blockIndex: 0 },
      "sudo reboot",
    );
  });
});
