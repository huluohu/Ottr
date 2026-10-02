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
  is_production: false,
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
    await waitFor(() =>
      expect((screen.getByTestId("form-port") as HTMLInputElement).value).toBe("21"),
    );
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

describe("HostForm 生产标记（Phase 2 Task 11，B11）", () => {
  function prodResponses() {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_create") return Promise.resolve({ ...existing, id: 20 });
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
  }

  it("默认不勾选；勾选后 hosts_create 载荷 is_production=true", async () => {
    prodResponses();
    render(<HostForm host={null} defaultGroupId={null} onClose={vi.fn()} />);
    const toggle = screen.getByTestId("form-production") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    fill("10.0.0.5", "22");
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_create", {
        input: expect.objectContaining({ is_production: true }),
      }),
    );
  });

  it("编辑模式回显现值；取消勾选提交 is_production=false", async () => {
    prodResponses();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_update") return Promise.resolve({ ...existing, is_production: false });
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    const prodHost: Host = { ...existing, is_production: true };
    render(<HostForm host={prodHost} defaultGroupId={null} onClose={vi.fn()} />);
    expect((screen.getByTestId("form-production") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("form-production")); // 取消标记
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_update", {
        id: 11,
        input: expect.objectContaining({ is_production: false }),
      }),
    );
  });
});

// Phase 5 T1（内联凭据）：凭据下拉「＋ 新建凭据…」→ 内联子表单就地填写，
// 保存主机时先建凭据（credentials_create，vault seal 路径与凭据对话框同源）
// 再建主机并绑定新凭据 id——用户全程不离开主机表单即可存密码。
describe("HostForm 内联凭据创建（Phase 5 T1）", () => {
  function credFlowResponses(cred: Record<string, unknown> | null) {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "credentials_create") {
        return cred
          ? Promise.resolve({ id: 7, kind: "password" })
          : Promise.reject(new Error("seal unavailable"));
      }
      if (cmd === "hosts_create") return Promise.resolve({ ...existing, id: 30 });
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
  }

  it("选「＋ 新建凭据…」展开内联子表单；保存主机 → 先建凭据再建主机并绑定", async () => {
    credFlowResponses({ id: 7 });
    const onClose = vi.fn();
    render(<HostForm host={null} defaultGroupId={null} onClose={onClose} />);

    // 下拉选「＋ 新建凭据…」→ 内联子表单就地展开（不离开主机表单）
    fireEvent.change(screen.getByTestId("form-credential"), { target: { value: "__new__" } });
    expect(screen.getByTestId("form-cred-inline")).toBeTruthy();
    // 默认密码型；密码就地填写
    expect((screen.getByTestId("cred-kind") as HTMLSelectElement).value).toBe("password");
    fireEvent.change(screen.getByTestId("cred-secret"), { target: { value: "s3cret" } });

    fill("10.0.0.9", "22");
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("credentials_create", {
        input: { kind: "password", secret: "s3cret", key_pub: null, passphrase: null, totp_secret: null },
      }),
    );
    // 主机载荷绑定新建凭据 id
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_create", {
        input: expect.objectContaining({ address: "10.0.0.9", credential_id: 7 }),
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("内联凭据密码留空：校验错误、不发 credentials_create / hosts_create", async () => {
    credFlowResponses({ id: 7 });
    const onClose = vi.fn();
    render(<HostForm host={null} defaultGroupId={null} onClose={onClose} />);
    fireEvent.change(screen.getByTestId("form-credential"), { target: { value: "__new__" } });
    fill("10.0.0.9", "22");
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("cred-error").textContent).toBe("Password is required"),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("credentials_create", expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith("hosts_create", expect.anything());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("凭据创建失败：错误落在内联子表单、主机不创建", async () => {
    credFlowResponses(null);
    const onClose = vi.fn();
    render(<HostForm host={null} defaultGroupId={null} onClose={onClose} />);
    fireEvent.change(screen.getByTestId("form-credential"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByTestId("cred-secret"), { target: { value: "s3cret" } });
    fill("10.0.0.9", "22");
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("cred-error").textContent).toContain("seal unavailable"),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("hosts_create", expect.anything());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("取消内联子表单：回到不绑定态，主机正常创建（credential_id null）", async () => {
    credFlowResponses({ id: 7 });
    render(<HostForm host={null} defaultGroupId={null} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("form-credential"), { target: { value: "__new__" } });
    expect(screen.getByTestId("form-cred-inline")).toBeTruthy();
    fireEvent.click(screen.getByTestId("form-cred-cancel"));
    expect(screen.queryByTestId("form-cred-inline")).toBeNull();
    fill("10.0.0.9", "22");
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_create", {
        input: expect.objectContaining({ credential_id: null }),
      }),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("credentials_create", expect.anything());
  });

  it("编辑模式同样可内联新建凭据并换绑（hosts_update 带 credential_id=新 id）", async () => {
    credFlowResponses({ id: 7 });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "credentials_create") return Promise.resolve({ id: 9, kind: "password" });
      if (cmd === "hosts_update") return Promise.resolve(existing);
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<HostForm host={existing} defaultGroupId={null} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("form-credential"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByTestId("cred-secret"), { target: { value: "np" } });
    fireEvent.click(screen.getByTestId("form-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_update", {
        id: 11,
        input: expect.objectContaining({ credential_id: 9 }),
      }),
    );
  });
});
