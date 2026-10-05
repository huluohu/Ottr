// KeyManager 组件测试（Task 6 裁定 #2/#7）：生成走 key_generate；导入加密私钥
// 缺口令报错；导出确认（未加密显式点击即可，加密钥 passphrase 验证不过不发
// key_export）；部署带 camelCase 参数并展示回执。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { KeyManager } from "./KeyManager";
import { useVaultStore } from "../vault/store";
import type { Credential, Host, KeyMaterial } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

const generated: KeyMaterial = {
  algorithm: "ed25519",
  private_openssh: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
  public_openssh: "ssh-ed25519 AAAA generated",
  fingerprint: "SHA256:qSN7JTePqMBmh4z4GPwkowdywkdV5ldIt1p5cwdRQPw",
};

const hostRow: Host = {
  id: 3,
  name: "spike",
  group_id: null,
  tags: [],
  address: "127.0.0.1",
  port: 2222,
  username: "spike",
  protocol: "ssh",
  credential_id: 5,
  jump_chain_id: null,
  encoding_override: null,
  theme_override: null,
  monitor_enabled: false,
  is_production: false,
  notes: null,
  created_at: 1,
  updated_at: 1,
};

const passCred: Credential = { id: 5, kind: "password", key_pub: null, created_at: 1, updated_at: 1 };
const totpCred: Credential = { id: 6, kind: "totp", key_pub: null, created_at: 1, updated_at: 1 };

function seedStore() {
  useVaultStore.setState({
    hosts: [hostRow],
    credentials: [passCred, totpCred],
    hostGroups: [],
    loading: false,
    error: null,
  });
}

function mockListsOnly() {
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`unexpected command: ${cmd}`));
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  seedStore();
});

afterEach(() => cleanup());

describe("KeyManager", () => {
  it("生成：key_generate 收到 algorithm/passphrase/comment，结果展示指纹与公钥", async () => {
    mockListsOnly();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "key_generate") return Promise.resolve(generated);
      return mockForLists(cmd);
    });
    render(<KeyManager />);
    fireEvent.click(screen.getByTestId("km-generate"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("key_generate", {
        algorithm: "ed25519",
        passphrase: null,
        comment: "ottr",
      }),
    );
    expect(screen.getByTestId("km-fingerprint").textContent).toBe(generated.fingerprint);
    expect(screen.getByTestId("km-public-key").textContent).toBe(generated.public_openssh);
  });

  it("生成带口令：passphrase 随 payload（密钥将加密）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "key_generate") return Promise.resolve(generated);
      return mockForLists(cmd);
    });
    render(<KeyManager />);
    fireEvent.change(screen.getByTestId("km-gen-passphrase"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByTestId("km-generate"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("key_generate", {
        algorithm: "ed25519",
        passphrase: "s3cret",
        comment: "ottr",
      }),
    );
  });

  it("导入加密私钥缺口令：key_inspect reject → 显示解析失败，无结果面板", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "key_inspect") return Promise.reject("KeyIsEncrypted: missing passphrase");
      return mockForLists(cmd);
    });
    render(<KeyManager />);
    fireEvent.change(screen.getByTestId("km-import-pem"), { target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----" } });
    fireEvent.click(screen.getByTestId("km-import"));
    await waitFor(() =>
      expect(screen.getByTestId("km-error").textContent).toContain("Parse failed"),
    );
    expect(screen.queryByTestId("km-result")).toBeNull();
  });

  it("导出未加密钥：显式点击 → 确认 → key_export；导出前有 inspect 校验的可选项不发", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "key_generate") return Promise.resolve(generated);
      if (cmd === "key_export") return Promise.resolve("/Downloads/ottr-key-1.pem");
      return mockForLists(cmd);
    });
    render(<KeyManager />);
    fireEvent.click(screen.getByTestId("km-generate"));
    await waitFor(() => expect(screen.getByTestId("km-result")).toBeTruthy());
    fireEvent.click(screen.getByTestId("km-export"));
    // 未加密钥确认框不带口令输入
    expect(screen.queryByTestId("km-export-passphrase")).toBeNull();
    fireEvent.click(screen.getByTestId("km-export-do"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("key_export", {
        pem: generated.private_openssh,
        path: null,
      }),
    );
    expect(screen.getByTestId("km-exported").textContent).toContain("/Downloads/ottr-key-1.pem");
  });

  it("导出加密钥（裁定 #2）：口令验证不过不发 key_export；通过才落盘", async () => {
    const encKey: KeyMaterial = { ...generated, fingerprint: "SHA256:f8TvmisjmAG/5XjlAaKDAU2/za3LuWqzkT4sh6Fo2fQ" };
    let inspectCalls = 0;
    mockedInvoke.mockImplementation((cmd: string, args?: { passphrase?: string | null }) => {
      if (cmd === "key_generate") return Promise.resolve(encKey);
      if (cmd === "key_inspect") {
        inspectCalls += 1;
        if (!args?.passphrase || args.passphrase !== "right") {
          return Promise.reject("wrong passphrase");
        }
        return Promise.resolve(encKey);
      }
      if (cmd === "key_export") return Promise.resolve("/Downloads/ottr-key-2.pem");
      return mockForLists(cmd);
    });
    render(<KeyManager />);
    fireEvent.change(screen.getByTestId("km-gen-passphrase"), { target: { value: "right" } });
    fireEvent.click(screen.getByTestId("km-generate"));
    await waitFor(() => expect(screen.getByTestId("km-result")).toBeTruthy());

    fireEvent.click(screen.getByTestId("km-export"));
    // 加密钥：确认框带口令输入
    const passInput = screen.getByTestId("km-export-passphrase");
    // 错口令 → inspect reject → 不发 key_export
    fireEvent.change(passInput, { target: { value: "wrong" } });
    fireEvent.click(screen.getByTestId("km-export-do"));
    await waitFor(() => expect(inspectCalls).toBe(1));
    await waitFor(() =>
      expect(screen.getByTestId("km-error").textContent).toContain("Export failed"),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("key_export", expect.anything());

    // 正确口令 → inspect 通过 → key_export 发出
    fireEvent.change(passInput, { target: { value: "right" } });
    fireEvent.click(screen.getByTestId("km-export-do"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("key_export", {
        pem: encKey.private_openssh,
        path: null,
      }),
    );
  });

  it("部署：TOTP 凭据不出现在登录凭据下拉；key_deploy 收 camelCase 参数并展示回执", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "key_deploy") {
        return Promise.resolve({
          status: "added",
          public_key_fingerprint: generated.fingerprint,
          host_key_fingerprint: "SHA256:HOSTFP",
          known_hosts_state: "pending",
        });
      }
      return mockForLists(cmd);
    });
    render(<KeyManager />);
    // 登录凭据下拉只有 password/key（TOTP 不可用于部署）
    const authSelect = screen.getByTestId("km-deploy-auth") as HTMLSelectElement;
    const authOptions = Array.from(authSelect.options).map((o) => o.text);
    expect(authOptions.some((txt) => txt.includes("totp"))).toBe(false);

    fireEvent.change(screen.getByTestId("km-deploy-host"), { target: { value: "3" } });
    fireEvent.change(authSelect, { target: { value: "5" } });
    // 公钥预填自生成结果；直接手填也行——这里先清空验证校验
    fireEvent.click(screen.getByTestId("km-deploy"));
    await waitFor(() =>
      expect(screen.getByTestId("km-error").textContent).toBe(
        "Public key must be a single non-empty line",
      ),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("key_deploy", expect.anything());

    fireEvent.change(screen.getByTestId("km-deploy-pub"), { target: { value: generated.public_openssh } });
    fireEvent.click(screen.getByTestId("km-deploy"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("key_deploy", {
        authCredentialId: 5,
        address: "127.0.0.1",
        port: 2222,
        username: "spike",
        publicKey: generated.public_openssh,
      }),
    );
    expect(screen.getByTestId("km-deploy-status").textContent).toBe("Appended to authorized_keys");
    expect(screen.getByTestId("km-deploy-result").textContent).toContain("SHA256:HOSTFP");
  });

  it("BL-204：主机无用户名时部署预拦截（行内错误，不发 key_deploy）", async () => {
    mockedInvoke.mockImplementation((cmd: string) => mockForLists(cmd));
    useVaultStore.setState({
      hosts: [{ ...hostRow, username: null }],
      credentials: [passCred],
      hostGroups: [],
      loading: false,
      error: null,
    });
    render(<KeyManager />);
    fireEvent.change(screen.getByTestId("km-deploy-host"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("km-deploy-auth"), { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("km-deploy-pub"), {
      target: { value: generated.public_openssh },
    });
    fireEvent.click(screen.getByTestId("km-deploy"));
    await waitFor(() => expect(screen.getByTestId("km-error").textContent).not.toBe(""));
    expect(mockedInvoke).not.toHaveBeenCalledWith("key_deploy", expect.anything());
  });
});

/** 列表命令统一返回空（refresh 依赖）。 */
function mockForLists(cmd: string): Promise<unknown> {
  if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
    return Promise.resolve([]);
  }
  return Promise.reject(new Error(`unexpected command: ${cmd}`));
}
