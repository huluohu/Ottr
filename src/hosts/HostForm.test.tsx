// HostForm 组件测试（Task 5 Step 4）：校验（地址非空/端口 1-65535）、
// 提交载荷 snake_case 形态、编辑模式走 hosts_update、名称空缺地址兜底。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { HostForm } from "./HostForm";
import { useVaultStore } from "../vault/store";
import type { Host } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

const existing: Host = {
  id: 11,
  name: "old-name",
  group_id: null,
  tags: [],
  address: "10.0.0.5",
  port: 22,
  username: null,
  protocol: "ssh",
  credential_id: null,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};

function listResponses() {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
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

function fill(address: string, port: string) {
  fireEvent.change(screen.getByTestId("form-address"), { target: { value: address } });
  fireEvent.change(screen.getByTestId("form-port"), { target: { value: port } });
}

describe("HostForm", () => {
  it("地址为空提交：显示校验错误，不发 hosts_create", async () => {
    render(<HostForm host={null} defaultGroupId={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("form-error").textContent).toBe("Host address is required"),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("hosts_create", expect.anything());
  });

  it("端口越界（0 / 70000 / 非数字）→ errPortRange，不发请求", async () => {
    render(<HostForm host={null} defaultGroupId={null} onClose={vi.fn()} />);
    for (const bad of ["0", "70000", "abc"]) {
      fill("10.0.0.9", bad);
      fireEvent.click(screen.getByTestId("form-submit"));
      await waitFor(() =>
        expect(screen.getByTestId("form-error").textContent).toBe(
          "Port must be an integer between 1 and 65535",
        ),
      );
    }
    expect(mockedInvoke).not.toHaveBeenCalledWith("hosts_create", expect.anything());
  });

  it("端口非十进制字面量（0x10 / 1e2 / 负号 / 内嵌空格）→ 拒绝（T5 M-4 收紧，Task 8）", async () => {
    render(<HostForm host={null} defaultGroupId={null} onClose={vi.fn()} />);
    // Number() 会把 "0x10" 解析成 16、"1e2" 成 100——宽松解析曾经放过它们；
    // 首尾空格 trim 后仍接受（与原 Number 行为一致），内嵌空格/其他进位写法拒绝。
    for (const bad of ["0x10", "1e2", "-22", "2 2"]) {
      fill("10.0.0.9", bad);
      fireEvent.click(screen.getByTestId("form-submit"));
      await waitFor(() =>
        expect(screen.getByTestId("form-error").textContent).toBe(
          "Port must be an integer between 1 and 65535",
        ),
      );
    }
    expect(mockedInvoke).not.toHaveBeenCalledWith("hosts_create", expect.anything());
  });

  it("合法输入：hosts_create 收到 snake_case 载荷（tags 拆分、空 username→null）", async () => {
    listResponses();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_create") {
        return Promise.resolve({ ...existing, id: 12, name: "gateway" });
      }
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    const onClose = vi.fn();
    render(<HostForm host={null} defaultGroupId={null} onClose={onClose} />);
    fireEvent.change(screen.getByTestId("form-name"), { target: { value: "gateway" } });
    fill("10.0.0.9", "22022");
    fireEvent.change(screen.getByTestId("form-username"), { target: { value: "root" } });
    fireEvent.change(screen.getByTestId("form-tags"), { target: { value: "prod, nginx" } });
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_create", {
        input: expect.objectContaining({
          name: "gateway",
          address: "10.0.0.9",
          port: 22022,
          username: "root",
          protocol: "ssh",
          tags: ["prod", "nginx"],
          encoding_override: null,
          notes: null,
        }),
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("协议选择（Phase 2 Task 5）：FTP 端口默认跟随（22→21），载荷带 protocol", async () => {
    listResponses();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_create") {
        return Promise.resolve({ ...existing, id: 13, name: "nas" });
      }
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    const onClose = vi.fn();
    render(<HostForm host={null} defaultGroupId={null} onClose={onClose} />);
    fill("192.168.1.50", "22");
    fireEvent.change(screen.getByTestId("form-protocol"), { target: { value: "ftp" } });
    // 端口仍在默认值上 → 跟随新协议默认 21；用户自定义端口不动（此处未验，见注释语义）
    await waitFor(() => expect(screen.getByTestId("form-port").value).toBe("21"));
    fireEvent.change(screen.getByTestId("form-name"), { target: { value: "nas" } });
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_create", {
        input: expect.objectContaining({ protocol: "ftp", port: 21 }),
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("名称留空以地址兜底（vault 拒绝空名）", async () => {
    listResponses();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_create") return Promise.resolve(existing);
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<HostForm host={null} defaultGroupId={null} onClose={vi.fn()} />);
    fill("10.1.1.1", "22");
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_create", {
        input: expect.objectContaining({ name: "10.1.1.1", address: "10.1.1.1" }),
      }),
    );
  });

  it("编辑模式：hosts_update 带 id 且载荷全量替换", async () => {
    listResponses();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_update") return Promise.resolve(existing);
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<HostForm host={existing} defaultGroupId={null} onClose={vi.fn()} />);
    // 编辑模式预填现值
    expect((screen.getByTestId("form-address") as HTMLInputElement).value).toBe("10.0.0.5");
    fireEvent.change(screen.getByTestId("form-name"), { target: { value: "renamed" } });
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_update", {
        id: 11,
        input: expect.objectContaining({ name: "renamed", address: "10.0.0.5", port: 22 }),
      }),
    );
  });

  it("后端报错显示 saveFailed 且不关闭", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_create") return Promise.reject("port conflict");
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    const onClose = vi.fn();
    render(<HostForm host={null} defaultGroupId={null} onClose={onClose} />);
    fill("10.0.0.9", "22");
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("form-submit-error").textContent).toContain("Save failed"),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
