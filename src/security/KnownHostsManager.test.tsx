// KnownHostsManager 组件测试（B9 裁定 #1）：列表渲染 / pending 一键 verify /
// changed「检查」取证对话框（信任新锚 or 信任原锚）/ 删除确认（忘记端点）/
// 立即巡检回执。vaultApi 直 mock——组件面只测编排，不测 Rust。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import "../i18n";
import { vaultApi, type KnownHost } from "../vault/api";
import { KnownHostsManager } from "./KnownHostsManager";

const mockedInvoke = invoke as unknown as Mock;

function row(partial: Partial<KnownHost>): KnownHost {
  return {
    host_key: "10.0.0.1:22",
    fingerprint: "SHA256:ANCHOR",
    first_seen: 1_700_000_000,
    verified: false,
    changed_at: null,
    state: "pending",
    ...partial,
  };
}

const pendingRow = row({ host_key: "10.0.0.1:22", state: "pending" });
const okRow = row({
  host_key: "10.0.0.2:22",
  fingerprint: "SHA256:OKKEY",
  state: "ok",
  verified: true,
});
const changedRow = row({
  host_key: "10.0.0.3:22",
  fingerprint: "SHA256:OLDKEY",
  state: "changed",
  changed_at: 1_700_000_100,
});

function mockImpl(list: KnownHost[]) {
  mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "known_hosts_list":
        return Promise.resolve(list);
      case "known_hosts_verify":
        return Promise.resolve(row({ ...list[0], state: "ok", verified: true }));
      case "known_hosts_probe":
        return Promise.resolve((args as { hostKey: string }).hostKey === "10.0.0.3:22"
          ? ["SHA256:NEWKEY", "SHA256:EXTRA"]
          : []);
      case "known_hosts_delete":
        return Promise.resolve(true);
      case "known_hosts_audit_run":
        return Promise.resolve({ checked: 1, changed: [] });
      default:
        return Promise.reject(new Error(`unexpected command ${cmd}`));
    }
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("KnownHostsManager", () => {
  it("列表渲染：端点/指纹/状态/时间列齐备，空表显示占位", async () => {
    mockImpl([pendingRow, okRow, changedRow]);
    const { unmount } = render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-table")).toBeTruthy());
    expect(screen.getByTestId("kh-row-10.0.0.1:22")).toBeTruthy();
    expect(screen.getByTestId("kh-row-10.0.0.2:22")).toBeTruthy();
    expect(screen.getByText("SHA256:OKKEY")).toBeTruthy();
    expect(screen.getByTestId("kh-state-10.0.0.3:22").textContent).toContain("已变更");
    expect(screen.getByTestId("kh-audit-now")).toBeTruthy();
    unmount();

    mockImpl([]);
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-empty")).toBeTruthy());
  });

  it("pending 一键信任：verify 以当前锚发起并刷新列表", async () => {
    mockImpl([pendingRow]);
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-verify-10.0.0.1:22")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-verify-10.0.0.1:22"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("known_hosts_verify", {
        hostKey: "10.0.0.1:22",
        fingerprint: "SHA256:ANCHOR",
      }),
    );
  });

  it("changed「检查」：probe 取证 → 对话框展示观测集 → 信任新指纹走 verify(新锚)", async () => {
    mockImpl([changedRow]);
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-check-10.0.0.3:22")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-check-10.0.0.3:22"));
    await waitFor(() => expect(screen.getByTestId("kh-probe-dialog")).toBeTruthy());
    expect(screen.getByTestId("kh-probe-anchor").textContent).toBe("SHA256:OLDKEY");
    expect(screen.getByTestId("kh-probe-seen").textContent).toContain("SHA256:NEWKEY");
    // 信任新指纹：verify(host, 新指纹)——接管信任锚的唯一入口
    fireEvent.click(screen.getByTestId("kh-trust-SHA256:NEWKEY"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("known_hosts_verify", {
        hostKey: "10.0.0.3:22",
        fingerprint: "SHA256:NEWKEY",
      }),
    );
    expect(screen.queryByTestId("kh-probe-dialog")).toBeNull();
  });

  it("changed 检查：观测集仍含原锚 → 提供「信任原指纹」（误报/超集出口）", async () => {
    mockImpl([changedRow]);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "known_hosts_list") return Promise.resolve([changedRow]);
      if (cmd === "known_hosts_probe") return Promise.resolve(["SHA256:OLDKEY", "SHA256:EXTRA"]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-check-10.0.0.3:22")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-check-10.0.0.3:22"));
    await waitFor(() => expect(screen.getByTestId("kh-trust-SHA256:OLDKEY")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-trust-SHA256:OLDKEY"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("known_hosts_verify", {
        hostKey: "10.0.0.3:22",
        fingerprint: "SHA256:OLDKEY",
      }),
    );
  });

  it("changed 检查：probe 失败（进程缺席）展示取证失败，不提供任何信任钮", async () => {
    mockImpl([changedRow]);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "known_hosts_list") return Promise.resolve([changedRow]);
      if (cmd === "known_hosts_probe") return Promise.reject(new Error("ssh-keyscan not found"));
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-check-10.0.0.3:22")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-check-10.0.0.3:22"));
    await waitFor(() => expect(screen.getByTestId("kh-probe-error")).toBeTruthy());
    expect(screen.getByTestId("kh-probe-error").textContent).toContain("ssh-keyscan");
    expect(screen.queryByTestId("kh-probe-seen")).toBeNull();
  });

  it("删除走确认框：确认后 known_hosts_delete 以端点键发起", async () => {
    mockImpl([okRow]);
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-delete-10.0.0.2:22")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-delete-10.0.0.2:22"));
    expect(screen.getByTestId("kh-delete-dialog")).toBeTruthy();
    expect(screen.getByTestId("kh-delete-hint").textContent).toContain("10.0.0.2:22");
    fireEvent.click(screen.getByTestId("kh-delete-confirm"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("known_hosts_delete", { hostKey: "10.0.0.2:22" }),
    );
  });

  it("删除确认框可取消（不发起任何删除调用）", async () => {
    mockImpl([okRow]);
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-delete-10.0.0.2:22")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-delete-10.0.0.2:22"));
    fireEvent.click(screen.getByTestId("kh-delete-cancel"));
    expect(screen.queryByTestId("kh-delete-dialog")).toBeNull();
    expect(vaultApi.knownHosts.remove).toBeDefined();
    expect(
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === "known_hosts_delete"),
    ).toHaveLength(0);
  });

  it("立即巡检：known_hosts_audit_run 发起并展示回执（checked/changed）", async () => {
    mockImpl([okRow]);
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-audit-now")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-audit-now"));
    await waitFor(() => expect(screen.getByTestId("kh-audit-result")).toBeTruthy());
    expect(mockedInvoke).toHaveBeenCalledWith("known_hosts_audit_run");
    expect(screen.getByTestId("kh-audit-result").textContent).toContain("1");
  });
});
