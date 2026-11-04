import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiSessionApi, type AiScope, type AiScopeTarget } from "./sessionApi";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const target: AiScopeTarget = {
  paneSessionId: "pane-a",
  rootTabId: "root-a",
  rustId: "pty-7",
  connectionEpoch: 3,
  kind: "ssh",
  hostId: 42,
};

const scope: AiScope = {
  ...target,
  scopeId: "scope-a",
  endpoint: "actual.example:2222",
  username: "connected-user",
};

beforeEach(() => {
  invoke.mockReset();
});

describe("aiSessionApi", () => {
  it("opens the exact target with camelCase run linkage and returns backend identity", async () => {
    invoke.mockResolvedValue(scope);
    await expect(aiSessionApi.open(target, "conversation-a", "request-a")).resolves.toEqual(scope);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_scope_open", {
      target,
      conversationId: "conversation-a",
      requestId: "request-a",
    });
  });

  it("keeps local targets explicit with no host", async () => {
    const local: AiScopeTarget = { ...target, rustId: "local-1", kind: "local", hostId: null };
    const opened: AiScope = { ...local, scopeId: "scope-local", endpoint: "local", username: null };
    invoke.mockResolvedValue(opened);
    await expect(aiSessionApi.open(local, "conversation-local", "request-local")).resolves.toEqual(opened);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_scope_open", {
      target: local,
      conversationId: "conversation-local",
      requestId: "request-local",
    });
  });

  it("reads context only by scope", async () => {
    invoke.mockResolvedValue({ tail: "target output", notes: "target notes" });
    await expect(aiSessionApi.context("scope-a", 8192)).resolves.toEqual({
      tail: "target output",
      notes: "target notes",
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_scope_context", { scopeId: "scope-a", bytes: 8192 });
  });

  it("inserts an action only by scope without appending execution bytes", async () => {
    invoke.mockResolvedValue(null);
    await expect(aiSessionApi.insert("scope-a", "action-a", "printf 'hello'")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_scope_insert", {
      scopeId: "scope-a",
      actionId: "action-a",
      text: "printf 'hello'",
    });
  });

  it("revokes only the supplied scope", async () => {
    invoke.mockResolvedValue(null);
    await expect(aiSessionApi.revoke("scope-a")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_scope_revoke", { scopeId: "scope-a" });
  });

  it("propagates backend rejection without a write_session fallback", async () => {
    invoke.mockRejectedValue("AI scope revoked");
    await expect(aiSessionApi.insert("scope-a", "action-a", "whoami")).rejects.toBe("AI scope revoked");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("ai_scope_insert", {
      scopeId: "scope-a",
      actionId: "action-a",
      text: "whoami",
    });
  });

  // 2026-11-04 第一步：只读两类 + 执行类一类的调用面。
  it("lists a directory by scope (read-only face)", async () => {
    invoke.mockResolvedValue({ path: "/etc", entries: [{ name: "hosts", isDir: false, size: 12 }] });
    await expect(aiSessionApi.listDir("scope-a", "/etc")).resolves.toEqual({
      path: "/etc",
      entries: [{ name: "hosts", isDir: false, size: 12 }],
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_scope_list_dir", {
      scopeId: "scope-a",
      path: "/etc",
    });
  });

  it("reads a file by scope (read-only face)", async () => {
    invoke.mockResolvedValue({ path: "/etc/hosts", size: 12, content: "127.0.0.1", truncated: false });
    await expect(aiSessionApi.readFile("scope-a", "/etc/hosts")).resolves.toEqual({
      path: "/etc/hosts",
      size: 12,
      content: "127.0.0.1",
      truncated: false,
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_scope_read_file", {
      scopeId: "scope-a",
      path: "/etc/hosts",
    });
  });

  it("executes by mode: the mode travels with the call (backend is the gate)", async () => {
    invoke.mockResolvedValue({
      executed: false,
      planned: true,
      stepId: "step-1",
      message: "recorded in the plan; not executed (plan mode)",
    });
    await expect(aiSessionApi.exec("scope-a", "run-1:exec:call_1", "df -h", "plan")).resolves.toEqual({
      executed: false,
      planned: true,
      stepId: "step-1",
      message: "recorded in the plan; not executed (plan mode)",
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("ai_scope_exec", {
      scopeId: "scope-a",
      actionId: "run-1:exec:call_1",
      command: "df -h",
      mode: "plan",
    });
  });
});
