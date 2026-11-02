// KnownHostsManager 组件测试（B9 裁定 #1）：列表渲染 / pending 一键 verify /
// changed「检查」取证对话框（信任新锚 or 信任原锚）/ 删除确认（忘记端点）/
// 立即巡检回执 / 导入本地 known_hosts（2026-11-02）。vaultApi 直 mock——
// 组件面只测编排，不测 Rust。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "../i18n";
import i18n from "../i18n";
import { vaultApi, type KnownHost, type KnownHostsImportReport } from "../vault/api";
import { KnownHostsManager } from "./KnownHostsManager";

const mockedInvoke = invoke as unknown as Mock;
const mockedOpen = open as unknown as Mock;

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
      case "known_hosts_import":
        return Promise.resolve(importReport);
      default:
        return Promise.reject(new Error(`unexpected command ${cmd}`));
    }
  });
}

/** 导入回执（mockImpl 的 known_hosts_import 返回值；用例内可覆写）。 */
let importReport: KnownHostsImportReport = {
  added: 0,
  skippedDuplicate: 0,
  skippedConflict: 0,
  skippedHashed: 0,
  skippedOther: 0,
  errors: [],
};

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedOpen.mockReset();
  importReport = {
    added: 0,
    skippedDuplicate: 0,
    skippedConflict: 0,
    skippedHashed: 0,
    skippedOther: 0,
    errors: [],
  };
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
    // 状态徽标走词典（语言中立——词典驱动断言，防止硬编码某语言文案）
    expect(screen.getByTestId("kh-state-10.0.0.3:22").textContent).toBe(
      i18n.t("knownHosts.state_changed"),
    );
    expect(i18n.t("knownHosts.state_changed")).not.toBe("knownHosts.state_changed");
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

// --- 导入本地 known_hosts（2026-11-02）-------------------------------------

describe("KnownHostsManager 导入 known_hosts", () => {
  it("工具条渲染导入按钮（选文件）与默认路径按钮 + 提示", async () => {
    mockImpl([okRow]);
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-import")).toBeTruthy());
    expect(screen.getByTestId("kh-import-default")).toBeTruthy();
    expect(screen.getByTestId("kh-import-hint")).toBeTruthy();
  });

  it("使用默认路径：known_hosts_import 以 path=null 发起", async () => {
    mockImpl([okRow]);
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-import-default")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-import-default"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("known_hosts_import", { path: null }),
    );
    // 默认路径按钮不弹原生对话框
    expect(mockedOpen).not.toHaveBeenCalled();
  });

  it("选择文件：先弹原生对话框，选中路径后以该路径发起导入", async () => {
    mockImpl([okRow]);
    mockedOpen.mockResolvedValue("/tmp/known_hosts");
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-import")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-import"));
    await waitFor(() => expect(mockedOpen).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("known_hosts_import", {
        path: "/tmp/known_hosts",
      }),
    );
  });

  it("原生对话框取消（返回 null）：不发起导入", async () => {
    mockImpl([okRow]);
    mockedOpen.mockResolvedValue(null);
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-import")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-import"));
    await waitFor(() => expect(mockedOpen).toHaveBeenCalled());
    expect(
      mockedInvoke.mock.calls.filter(([cmd]) => cmd === "known_hosts_import"),
    ).toHaveLength(0);
  });

  it("报告显示新增/重复/冲突计数；冲突显著提示（既有端点未被覆盖，仍会弹确认）", async () => {
    mockImpl([okRow]);
    importReport = {
      added: 3,
      skippedDuplicate: 1,
      skippedConflict: 2,
      skippedHashed: 0,
      skippedOther: 0,
      errors: [],
    };
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-import-default")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-import-default"));
    await waitFor(() => expect(screen.getByTestId("kh-import-result")).toBeTruthy());
    const text = screen.getByTestId("kh-import-result").textContent ?? "";
    expect(text).toContain("3");
    expect(text).toContain("1");
    expect(text).toContain("2");
    // 冲突必须显著提示
    expect(screen.getByTestId("kh-import-conflict")).toBeTruthy();
  });

  it("跳过计数必须展示（真机 2026-11-02：设备真实 known_hosts 37 条全 hashed，报告只说「新增 0 条」用户无法判断原因）", async () => {
    mockImpl([okRow]);
    importReport = {
      added: 0,
      skippedDuplicate: 0,
      skippedConflict: 0,
      skippedHashed: 37,
      skippedOther: 5,
      errors: [],
    };
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-import-default")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-import-default"));
    await waitFor(() => expect(screen.getByTestId("kh-import-skipped")).toBeTruthy());
    const skipped = screen.getByTestId("kh-import-skipped").textContent ?? "";
    expect(skipped).toContain("37");
    expect(skipped).toContain("5");
  });

  it("无跳过项时不展示跳过行（不制造噪音）", async () => {
    mockImpl([okRow]);
    importReport = {
      added: 2,
      skippedDuplicate: 0,
      skippedConflict: 0,
      skippedHashed: 0,
      skippedOther: 0,
      errors: [],
    };
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-import-default")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-import-default"));
    await waitFor(() => expect(screen.getByTestId("kh-import-result")).toBeTruthy());
    expect(screen.queryByTestId("kh-import-skipped")).toBeNull();
  });

  it("文件不存在：展示「未找到文件」提示（不算导入失败）", async () => {
    mockImpl([okRow]);
    importReport = {
      added: 0,
      skippedDuplicate: 0,
      skippedConflict: 0,
      skippedHashed: 0,
      skippedOther: 0,
      errors: ["known_hosts_file_not_found: /Users/me/.ssh/known_hosts"],
    };
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-import-default")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-import-default"));
    await waitFor(() => expect(screen.getByTestId("kh-import-notfound")).toBeTruthy());
    expect(
      screen.getByTestId("kh-import-notfound").textContent,
    ).not.toBe("knownHosts.importNotFound");
  });

  it("导入后刷新列表（新锚出现在表里）", async () => {
    mockImpl([okRow]);
    importReport = {
      added: 1,
      skippedDuplicate: 0,
      skippedConflict: 0,
      skippedHashed: 0,
      skippedOther: 0,
      errors: [],
    };
    render(<KnownHostsManager />);
    await waitFor(() => expect(screen.getByTestId("kh-import-default")).toBeTruthy());
    fireEvent.click(screen.getByTestId("kh-import-default"));
    await waitFor(() =>
      expect(
        mockedInvoke.mock.calls.filter(([cmd]) => cmd === "known_hosts_list").length,
      ).toBeGreaterThan(1),
    );
  });
});
