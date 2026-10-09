// ForwardPanel 组件测试（Phase 2 Task 1 Step 4；T4 迁 dock 后原样随迁——
// 面板级关闭钮归 dock 壳，其行为在 dock/DockPanel.test 锁定）：列表渲染（端点/主机/字节
// 人话格式）、状态灯档位映射、启停按钮（pf_start 带 rustId / 未连接禁用）、
// enabled 开关落库、删除、添加表单校验（local 缺 target 拒绝 / dynamic 免
// target）与成功提交（pf_create + 刷新）。invoke 全量 mock（有状态后端：
// list 反映 create/delete 效果，同 NotificationCenter.test 的 seedBackend 纪律）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import i18n from "../i18n";
import { ForwardPanel, formatBytes, lightOf } from "./ForwardPanel";
import { useSessionStore, type Session } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import type { Host, PortForwardView } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

function host(over: Partial<Host> = {}): Host {
  return {
    id: 1,
    name: "fx-host",
    group_id: null,
    tags: [],
    address: "127.0.0.1",
    port: 2222,
    username: "spike",
    protocol: "ssh",
    credential_id: null,
    jump_chain_id: null,
    encoding_override: null,
    theme_override: null,
    monitor_enabled: false,
    is_production: false,
    notes: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function row(over: Partial<PortForwardView> = {}): PortForwardView {
  return {
    id: 11,
    host_id: 1,
    host_name: "fx-host",
    kind: "local",
    bind_addr: "127.0.0.1",
    bind_port: 8080,
    target_host: "db.internal",
    target_port: 5432,
    enabled: true,
    auto_reconnect: true,
    runtime: null,
    ...over,
  };
}

function seedSession(over: Partial<Session> = {}) {
  const session: Session = {
    id: "tab-1",
    hostId: 1,
    hostName: "fx-host",
    address: "127.0.0.1",
    port: 2222,
    username: "spike",
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: "pty-7",
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encodingOverride: "utf-8",
    encoding: "utf-8",
    encodingHint: null,
    isProduction: false,
    ...over,
  };
  useSessionStore.setState({ sessions: [session] });
}

/** 有状态 mock 后端：pf_list 的真源随 create/remove/setEnabled 记账（面板
 * 每个动作后 refresh，空 mock 会被刷掉）。 */
function seedBackend(rows: PortForwardView[]) {
  const data = rows.map((r) => ({ ...r }));
  let nextId = 100;
  mockedInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "pf_list":
        // 新数组 + 行拷贝（真后端每次 serde 序列化都是新对象；同引用会被
        // React setState bail-out 吞掉，面板将不重渲染）。
        return data.map((r) => ({ ...r }));
      case "pf_create": {
        const input = args?.input as PortForwardView;
        const created = { ...input, id: nextId++, host_name: "fx-host", runtime: null };
        data.push(created);
        return created;
      }
      case "pf_delete": {
        const id = args?.id as number;
        const idx = data.findIndex((r) => r.id === id);
        if (idx === -1) throw new Error(`port_forward id=${id} not found`);
        data.splice(idx, 1);
        return undefined;
      }
      case "pf_set_enabled": {
        const id = args?.id as number;
        const r = data.find((x) => x.id === id);
        if (!r) throw new Error("not found");
        r.enabled = args?.enabled as boolean;
        return undefined;
      }
      case "pf_start": {
        const r = data.find((x) => x.id === (args?.id as number));
        if (!r) throw new Error("not found");
        r.runtime = {
          session_id: args?.sessionId as string,
          state: "active",
          error: null,
          tx_bytes: 0,
          rx_bytes: 0,
          connections: 0,
          conn_errors: 0,
          bound_port: r.bind_port || 54321,
        };
        return r.runtime;
      }
      case "pf_stop": {
        const r = data.find((x) => x.id === (args?.id as number));
        if (r) r.runtime = null;
        return true;
      }
      case "hosts_list":
        return [host()];
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  });
}

// 词典固定 zh-CN（jsdom navigator.language 是 en-US；HistorySearch.test 同款
// 纪律——断言走中文词典文案，afterEach 拧回 en-US 免跨文件污染）。
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useVaultStore.setState({ hosts: [host()] });
  seedSession();
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  useSessionStore.setState({ sessions: [] });
  await i18n.changeLanguage("en-US");
});

describe("纯函数面", () => {
  it("formatBytes 人话格式", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
  });

  it("lightOf 档位映射：runtime 缺失/stopped = off，error 优先可见", () => {
    expect(lightOf(row({ runtime: null }))).toBe("off");
    expect(
      lightOf(
        row({
          runtime: {
            session_id: "p",
            state: "stopped",
            error: null,
            tx_bytes: 0,
            rx_bytes: 0,
            connections: 0,
            conn_errors: 0,
            bound_port: 1,
          },
        }),
      ),
    ).toBe("off");
    expect(
      lightOf(
        row({
          runtime: {
            session_id: "p",
            state: "active",
            error: null,
            tx_bytes: 1,
            rx_bytes: 1,
            connections: 1,
            conn_errors: 0,
            bound_port: 1,
          },
        }),
      ),
    ).toBe("active");
    expect(
      lightOf(
        row({
          runtime: {
            session_id: "p",
            state: "error",
            error: "bind failed",
            tx_bytes: 0,
            rx_bytes: 0,
            connections: 0,
            conn_errors: 0,
            bound_port: 1,
          },
        }),
      ),
    ).toBe("error");
  });
});

describe("列表与运行面", () => {
  it("渲染行：端点/主机/kind/状态灯档位", async () => {
    seedBackend([
      row({
        runtime: {
          session_id: "pty-7",
          state: "active",
          error: null,
          tx_bytes: 2048,
          rx_bytes: 4096,
          connections: 3,
          conn_errors: 0,
          bound_port: 8080,
        },
      }),
    ]);
    render(<ForwardPanel open />);
    await waitFor(() => expect(screen.getByTestId("forward-row-11")).toBeTruthy());
    expect(screen.getByTestId("forward-list").textContent).toContain("127.0.0.1:8080");
    expect(screen.getByTestId("forward-list").textContent).toContain("db.internal:5432");
    expect(screen.getByTestId("forward-list").textContent).toContain("fx-host");
    expect(screen.getByTestId("forward-list").textContent).toContain("2.0 KB");
    expect(screen.getByTestId("forward-list").textContent).toContain("4.0 KB");
    expect(document.querySelector(".forward-light[data-state='active']")).not.toBeNull();
  });

  it("空态文案", async () => {
    seedBackend([]);
    render(<ForwardPanel open />);
    await waitFor(() => expect(screen.getByTestId("forward-empty")).toBeTruthy());
  });

  it("启动：pf_start 带 rustId，成功后面板回显 runtime", async () => {
    seedBackend([row()]);
    render(<ForwardPanel open />);
    await waitFor(() => expect(screen.getByTestId("forward-start-11")).toBeTruthy());
    fireEvent.click(screen.getByTestId("forward-start-11"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("pf_start", { id: 11, sessionId: "pty-7" }),
    );
    // mock 后端记账 runtime → 刷新后按钮换成 stop（轮询窗口 2s > 默认 1s，
    // 显式放宽等待）
    await waitFor(() => expect(screen.getByTestId("forward-stop-11")).toBeTruthy(), {
      timeout: 3000,
    });
  });

  it("未连接（rustId null）→ start 禁用并带提示", async () => {
    seedSession({ rustId: null, status: "disconnected" });
    seedBackend([row()]);
    render(<ForwardPanel open />);
    await waitFor(() => expect(screen.getByTestId("forward-start-11")).toBeTruthy());
    const btn = screen.getByTestId("forward-start-11") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).not.toBe("");
  });

  it("停止与删除调用对应命令并刷新", async () => {
    seedBackend([
      row({
        runtime: {
          session_id: "pty-7",
          state: "active",
          error: null,
          tx_bytes: 1,
          rx_bytes: 1,
          connections: 1,
          conn_errors: 0,
          bound_port: 8080,
        },
      }),
    ]);
    render(<ForwardPanel open />);
    await waitFor(() => expect(screen.getByTestId("forward-stop-11")).toBeTruthy());
    fireEvent.click(screen.getByTestId("forward-stop-11"));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("pf_stop", { id: 11 }));
    // 停止后 runtime 清空 → 回到 start 按钮
    await waitFor(() => expect(screen.getByTestId("forward-start-11")).toBeTruthy());

    fireEvent.click(screen.getByTestId("forward-delete-11"));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("pf_delete", { id: 11 }));
    await waitFor(() => expect(screen.queryByTestId("forward-row-11")).toBeNull());
  });

  it("enabled 开关落库（pf_set_enabled 翻转值）", async () => {
    seedBackend([row({ enabled: true })]);
    render(<ForwardPanel open />);
    await waitFor(() => expect(screen.getByTestId("forward-enabled-11")).toBeTruthy());
    const box = screen.getByTestId("forward-enabled-11") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("pf_set_enabled", { id: 11, enabled: false }),
    );
  });
});

describe("添加表单", () => {
  it("local 缺 target → 校验拒绝不发命令；补齐后 pf_create + 刷新", async () => {
    seedBackend([row()]);
    render(<ForwardPanel open />);
    await waitFor(() => expect(screen.getByTestId("forward-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("forward-add"));
    fireEvent.change(screen.getByTestId("forward-form-bind-port"), {
      target: { value: "9090" },
    });
    // target 留空 → 校验错误，无 invoke
    fireEvent.click(screen.getByTestId("forward-form-save"));
    expect(screen.getByTestId("forward-form-error").textContent).not.toBe("");
    const pfCalls = mockedInvoke.mock.calls.filter(([c]) => c === "pf_create");
    expect(pfCalls).toHaveLength(0);

    fireEvent.change(screen.getByTestId("forward-form-target-host"), {
      target: { value: "db.internal" },
    });
    fireEvent.change(screen.getByTestId("forward-form-target-port"), {
      target: { value: "5432" },
    });
    fireEvent.click(screen.getByTestId("forward-form-save"));
    // 注意重新过滤（pfCalls 是旧快照；mock.calls 在增长）
    await waitFor(() =>
      expect(mockedInvoke.mock.calls.filter(([c]) => c === "pf_create")).toHaveLength(1),
    );
    const pfCalls2 = mockedInvoke.mock.calls.filter(([c]) => c === "pf_create");
    expect(pfCalls2[0][1].input).toMatchObject({
      host_id: 1,
      kind: "local",
      bind_port: 9090,
      target_host: "db.internal",
      target_port: 5432,
      enabled: true,
      auto_reconnect: true,
    });
    // 新行进入列表（有状态后端记账 + 刷新）
    await waitFor(() => expect(screen.getByTestId("forward-row-100")).toBeTruthy());
  });

  it("dynamic 隐藏 target 字段且载荷 target 为 null", async () => {
    seedBackend([row()]);
    render(<ForwardPanel open />);
    await waitFor(() => expect(screen.getByTestId("forward-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("forward-add"));
    fireEvent.change(screen.getByTestId("forward-form-kind"), { target: { value: "dynamic" } });
    expect(screen.queryByTestId("forward-form-target-host")).toBeNull();
    fireEvent.change(screen.getByTestId("forward-form-host"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("forward-form-bind-port"), {
      target: { value: "1080" },
    });
    fireEvent.click(screen.getByTestId("forward-form-save"));
    await waitFor(() => {
      const calls = mockedInvoke.mock.calls.filter(([c]) => c === "pf_create");
      expect(calls).toHaveLength(1);
      expect(calls[0][1].input).toMatchObject({
        kind: "dynamic",
        bind_port: 1080,
        target_host: null,
        target_port: null,
      });
    });
  });

  it("非法监听端口 → 校验错误不发命令", async () => {
    seedBackend([row()]);
    render(<ForwardPanel open />);
    await waitFor(() => expect(screen.getByTestId("forward-add")).toBeTruthy());
    fireEvent.click(screen.getByTestId("forward-add"));
    fireEvent.change(screen.getByTestId("forward-form-bind-port"), {
      target: { value: "abc" },
    });
    fireEvent.change(screen.getByTestId("forward-form-target-host"), {
      target: { value: "db" },
    });
    fireEvent.change(screen.getByTestId("forward-form-target-port"), {
      target: { value: "5432" },
    });
    fireEvent.click(screen.getByTestId("forward-form-save"));
    expect(screen.getByTestId("forward-form-error").textContent).not.toBe("");
    expect(mockedInvoke.mock.calls.filter(([c]) => c === "pf_create")).toHaveLength(0);
  });
});

