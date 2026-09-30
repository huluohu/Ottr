// ImportDialog 组件测试（Task 5 Step 4）：导入对话流——运行态、完成报告
// （新增/跳过/解析错误行，裁定 #4）、失败态与重试、完成后刷新 store。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
