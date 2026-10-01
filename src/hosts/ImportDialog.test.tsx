// ImportDialog 组件测试（Task 5 Step 4）：导入对话流——运行态、完成报告
// （新增/跳过/解析错误行，裁定 #4）、失败态与重试、完成后刷新 store。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// B3 迁移导入器：原生路径选择对话框 mock（可注入 picked 值/拒绝）。
const mockOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => mockOpen(...args) }));

import "../i18n";
import { ImportDialog } from "./ImportDialog";
import { useVaultStore } from "../vault/store";

const mockedInvoke = invoke as unknown as Mock;

const report = { added: 3, skipped_wildcards: 2, skipped_duplicates: 1, errors: ["L29: Port 'not-a-port' 不可解析"] };

function listCommandsOk() {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "import_ssh_config") return Promise.resolve(report);
    if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockOpen.mockReset();
  useVaultStore.setState({ hosts: [], hostGroups: [], credentials: [], loading: false, error: null });
});

afterEach(() => cleanup());

describe("ImportDialog", () => {
  it("idle → running → done：报告展示新增/跳过/错误行，完成后刷新 store", async () => {
    listCommandsOk();
    render(<ImportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("import-start"));

    expect(screen.getByTestId("import-running").textContent).toContain("Parsing and importing");
    await waitFor(() => expect(screen.getByTestId("import-report")).toBeTruthy());
    expect(screen.getByTestId("import-report").textContent).toContain("Added 3 hosts");
    expect(screen.getByTestId("import-report").textContent).toContain("Skipped 2 wildcard/exclude patterns");
    expect(screen.getByTestId("import-report").textContent).toContain("Skipped 1 duplicate hosts");
    expect(mockedInvoke).toHaveBeenCalledWith("import_ssh_config", { path: null });

    // 错误行列表逐行展示
    const errors = screen.getByTestId("import-errors");
    expect(errors.textContent).toContain("L29");

    // 完成后触发 refresh（hosts_list 被再次调用；store 直取 list 是单参 invoke）
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("hosts_list"));
  });

  it("零新增时显示 addedZero 文案", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "import_ssh_config") {
        return Promise.resolve({ added: 0, skipped_wildcards: 0, skipped_duplicates: 4, errors: [] });
      }
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<ImportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("import-start"));
    await waitFor(() => expect(screen.getByTestId("import-report")).toBeTruthy());
    expect(screen.getByTestId("import-report").textContent).toContain("No hosts added");
    expect(screen.getByTestId("import-report").textContent).toContain("No parse errors");
  });

  it("导入失败：显示 failed 消息，点 Retry 重发", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "import_ssh_config") return Promise.reject("read ~/.ssh/config: not found");
      return Promise.resolve([]);
    });
    render(<ImportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("import-start"));
    await waitFor(() => expect(screen.getByTestId("import-failed")).toBeTruthy());
    expect(screen.getByTestId("import-failed").textContent).toContain("not found");

    listCommandsOk();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("import-report")).toBeTruthy());
  });

  it("完成 → Done 关闭对话框", async () => {
    listCommandsOk();
    const onClose = vi.fn();
    render(<ImportDialog onClose={onClose} />);
    fireEvent.click(screen.getByTestId("import-start"));
    await waitFor(() => expect(screen.getByTestId("import-close")).toBeTruthy());
    fireEvent.click(screen.getByTestId("import-close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ImportDialog 迁移导入器来源（Phase 2 Task 10，B3）", () => {
  it("Xshell 来源：目录选择后 start 携路径发 import_xshell_sessions；跳过行换语义标签", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "import_xshell_sessions") {
        return Promise.resolve({ added: 2, skipped_wildcards: 1, skipped_duplicates: 0, errors: ["badport.xsh: Port 'not-a-port' 不可解析"] });
      }
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    mockOpen.mockResolvedValue("/Users/ottr/Sessions");
    render(<ImportDialog onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("import-source-xshell"));
    expect(screen.getByTestId("import-pick")).toBeTruthy();
    fireEvent.click(screen.getByTestId("import-pick"));
    await waitFor(() => expect(screen.getByTestId("import-path").textContent).toBe("/Users/ottr/Sessions"));

    fireEvent.click(screen.getByTestId("import-start"));
    await waitFor(() => expect(screen.getByTestId("import-report")).toBeTruthy());
    expect(mockedInvoke).toHaveBeenCalledWith("import_xshell_sessions", { path: "/Users/ottr/Sessions" });
    expect(screen.getByTestId("import-report").textContent).toContain("Added 2 hosts");
    expect(screen.getByTestId("import-report").textContent).toContain("Skipped 1 unusable entries/files");
    expect(screen.getByTestId("import-errors").textContent).toContain("badport.xsh");
  });

  it("Tabby 来源：未选文件时 start 禁用；选 JSON 后发 import_tabby_config", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "import_tabby_config") {
        return Promise.resolve({ added: 3, skipped_wildcards: 2, skipped_duplicates: 1, errors: [] });
      }
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<ImportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("import-source-tabby"));
    const start = screen.getByTestId("import-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true); // 无跨平台惯例位置：必须先选文件

    mockOpen.mockResolvedValue("/Users/ottr/tabby-config.json");
    fireEvent.click(screen.getByTestId("import-pick"));
    await waitFor(() => expect((screen.getByTestId("import-start") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByTestId("import-start"));
    await waitFor(() => expect(screen.getByTestId("import-report")).toBeTruthy());
    expect(mockedInvoke).toHaveBeenCalledWith("import_tabby_config", { path: "/Users/ottr/tabby-config.json" });
    expect(screen.getByTestId("import-report").textContent).toContain("No parse errors");
  });

  it("Xshell 未选路径：start 发 path=null（回落服务端默认会话目录）；切换来源清报告", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "import_xshell_sessions") {
        return Promise.resolve({ added: 1, skipped_wildcards: 0, skipped_duplicates: 0, errors: [] });
      }
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<ImportDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("import-source-xshell"));
    fireEvent.click(screen.getByTestId("import-start")); // 未 pick：null → 服务端默认
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("import_xshell_sessions", { path: null }),
    );

    // 回 ssh 再进 xshell：pickedPath/报告已清（idle 面重新可见）
    fireEvent.click(screen.getByTestId("import-close"));
    fireEvent.click(screen.getByTestId("import-source-ssh"));
    fireEvent.click(screen.getByTestId("import-source-xshell"));
    expect(screen.queryByTestId("import-path")).toBeNull();
    expect(mockOpen).toHaveBeenCalledTimes(0); // 本轮未再 pick
  });
});
