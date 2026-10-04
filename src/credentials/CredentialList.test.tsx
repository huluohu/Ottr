// CredentialList 组件测试（Task 6 裁定 #6/#7）：删除确认框提示「N 台主机将
// 解除绑定」（从 hosts 数据现算）、取消不动、确认发 credentials_delete 并刷新。
// T11：密码复制——vault_copy_credential_secret（明文不回前端），按钮态「已复制」。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { CredentialList } from "./CredentialList";
import { useVaultStore } from "../vault/store";
import type { Credential, Host } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

function cred(id: number, kind: Credential["kind"], keyPub: string | null = null): Credential {
  return { id, kind, key_pub: keyPub, created_at: 1, updated_at: 1 };
}

function host(id: number, credentialId: number | null): Host {
  return {
    id,
    name: `host-${id}`,
    group_id: null,
    tags: [],
    address: "10.0.0.1",
    port: 22,
    username: null,
    protocol: "ssh",
    credential_id: credentialId,
    jump_chain_id: null,
    encoding_override: null,
    theme_override: null,
    monitor_enabled: false,
    is_production: false,
    notes: null,
    created_at: 1,
    updated_at: 1,
  };
}

function seedStore(hosts: Host[], credentials: Credential[]) {
  useVaultStore.setState({ hosts, credentials, hostGroups: [], loading: false, error: null });
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

afterEach(() => cleanup());

describe("CredentialList 删除确认", () => {
  it("确认框提示 N 台主机将解除绑定（从 hosts.credential_id 现算）", async () => {
    seedStore([host(1, 7), host(2, 7), host(3, null)], [cred(7, "password"), cred(8, "key")]);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<CredentialList />);
    fireEvent.click(screen.getByTestId("cred-delete-7"));
    expect(screen.getByTestId("cred-confirm-text").textContent).toBe(
      "2 hosts will be unbound.",
    );
    // 未确认前不发删除
    expect(mockedInvoke).not.toHaveBeenCalledWith("credentials_delete", expect.anything());
  });

  it("无绑定主机：提示当前没有主机绑定此凭据", () => {
    seedStore([host(1, null)], [cred(7, "key")]);
    render(<CredentialList />);
    fireEvent.click(screen.getByTestId("cred-delete-7"));
    expect(screen.getByTestId("cred-confirm-text").textContent).toBe(
      "No hosts currently bound to this credential.",
    );
  });

  it("取消：不发请求，确认条消失", () => {
    seedStore([host(1, 7)], [cred(7, "password")]);
    render(<CredentialList />);
    fireEvent.click(screen.getByTestId("cred-delete-7"));
    fireEvent.click(screen.getByTestId("cred-cancel-delete"));
    expect(screen.queryByTestId("cred-confirm-7")).toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalledWith("credentials_delete", expect.anything());
  });

  it("确认：发 credentials_delete + 三表 refresh", async () => {
    seedStore([host(1, 7)], [cred(7, "password")]);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "credentials_delete") return Promise.resolve();
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<CredentialList />);
    fireEvent.click(screen.getByTestId("cred-delete-7"));
    fireEvent.click(screen.getByTestId("cred-confirm-delete"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("credentials_delete", { id: 7 }),
    );
    // 删除后刷新（删凭据会解绑主机，hosts 必须重拉）
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("hosts_list"));
  });

  it("列表展示 kind 徽标、绑定计数与公钥摘要（公钥非敏感可展示，私钥材料永不出现）", () => {
    seedStore(
      [host(1, 9)],
      [cred(9, "key", "ssh-ed25519 AAAAQUFQc3Bpa2U user@host")],
    );
    render(<CredentialList />);
    const item = screen.getByTestId("cred-item-9");
    expect(item.textContent).toContain("Key");
    expect(item.textContent).toContain("1 hosts bound");
    // key 指纹（批次三 T3 BL-529）：# + base36 短指纹（旧「base64 头 12 字符」
    // 在同型 key 下恒同，改切指纹）
    expect(item.querySelector(".cred-pub")?.textContent).toMatch(/^#[0-9a-z]+$/);
    // 私钥材料（即使是误传的 secret 字段）永不渲染
    expect(item.textContent).not.toContain("PRIVATE KEY");
    expect(item.textContent).not.toContain("BEGIN OPENSSH");
  });

  it("同型（ed25519）双凭据指纹互异（BL-529：头 12 字符病灶不可辨）", () => {
    seedStore(
      [host(1, 9), host(2, 10)],
      [
        cred(9, "key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx8vQ0Tc1a2 kate@web-01"),
        cred(10, "key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFz9wR1Ud2e3 ops@db-01"),
      ],
    );
    render(<CredentialList />);
    const fp9 = screen.getByTestId("cred-item-9").querySelector(".cred-pub")?.textContent;
    const fp10 = screen.getByTestId("cred-item-10").querySelector(".cred-pub")?.textContent;
    expect(fp9).toBeTruthy();
    expect(fp10).toBeTruthy();
    expect(fp9).not.toBe(fp10);
  });
});

describe("CredentialList 密码复制（T11）", () => {
  it("password 凭据显示复制按钮，点击发 vault_copy_credential_secret 并亮「已复制」", async () => {
    seedStore([host(1, 7)], [cred(7, "password"), cred(8, "key")]);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      if (cmd === "vault_copy_credential_secret") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<CredentialList />);
    // key 凭据无复制按钮（复制面 = password 凭据的 secret）
    expect(screen.queryByTestId("cred-copy-8")).toBeNull();
    fireEvent.click(screen.getByTestId("cred-copy-7"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("vault_copy_credential_secret", {
        id: 7,
        field: "secret",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("cred-copy-7").textContent).toBe("Copied"));
  });

  it("复制失败：错误条展示（命令拒绝路径）", async () => {
    seedStore([host(1, 7)], [cred(7, "password")]);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      if (cmd === "vault_copy_credential_secret") {
        return Promise.reject("credential id=7 has no secret in \"secret\"");
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<CredentialList />);
    fireEvent.click(screen.getByTestId("cred-copy-7"));
    await waitFor(() =>
      expect(screen.getByTestId("cred-list-error").textContent).toContain("Copy failed"),
    );
  });
});
