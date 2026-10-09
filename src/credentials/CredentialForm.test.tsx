// CredentialForm 组件测试（Task 6 裁定 #6/#7）：校验（password/key 必填、私钥
// PEM 粗检、TOTP base32 粗检）、password 显隐切换、passphrase 恒遮蔽、
// 提交载荷 snake_case、编辑留空 → patch null 保留现值。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { CredentialForm } from "./CredentialForm";
import { useVaultStore } from "../vault/store";
import type { Credential } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

const existing: Credential = {
  id: 7,
  kind: "password",
  name: null,
  key_pub: null,
  created_at: 1,
  updated_at: 1,
};

function mockLists() {
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

function setKind(kind: string) {
  fireEvent.change(screen.getByTestId("cred-kind"), { target: { value: kind } });
}

describe("CredentialForm", () => {
  it("密码为空提交：显示校验错误，不发 credentials_create", async () => {
    render(<CredentialForm credential={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("cred-error").textContent).toBe("Password is required"),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("credentials_create", expect.anything());
  });

  it("password 显隐切换：默认遮蔽，点击切换为明文再切回", () => {
    render(<CredentialForm credential={null} onClose={vi.fn()} />);
    const input = screen.getByTestId("cred-secret") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByTestId("cred-toggle-secret"));
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByTestId("cred-toggle-secret"));
    expect(input.type).toBe("password");
  });

  it("key：私钥必填 + PEM 粗检；passphrase 恒遮蔽", async () => {
    render(<CredentialForm credential={null} onClose={vi.fn()} />);
    setKind("key");
    // 明显不是私钥
    fireEvent.change(screen.getByTestId("cred-private-key"), { target: { value: "hello world" } });
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("cred-error").textContent).toBe("Not a private key PEM block"),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("credentials_create", expect.anything());

    // passphrase 输入恒为遮蔽（裁定 #6：不做显隐切换）
    expect((screen.getByTestId("cred-passphrase") as HTMLInputElement).type).toBe("password");
  });

  it("totp：base32 粗检（非法字符拒绝；合法 base32 通过并 snake_case 落 totp_secret）", async () => {
    mockLists();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "credentials_create") {
        return Promise.resolve(existing);
      }
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    const onClose = vi.fn();
    render(<CredentialForm credential={null} onClose={onClose} />);
    setKind("totp");
    // 非法：base32 字符集外（1/8/9 不在 RFC 4648 base32 字母表）
    fireEvent.change(screen.getByTestId("cred-totp-secret"), { target: { value: "ABC12319!" } });
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("cred-error").textContent).toBe(
        "TOTP secret must be base32 (A-Z, 2-7, optional = padding)",
      ),
    );

    // 合法（含空格分组）
    fireEvent.change(screen.getByTestId("cred-totp-secret"), { target: { value: "jbsw y3dp ehpk 3pxp" } });
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("credentials_create", {
        input: expect.objectContaining({
          kind: "totp",
          totp_secret: "jbsw y3dp ehpk 3pxp",
          secret: null,
          passphrase: null,
        }),
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("编辑模式：密钥留空 → patch 全 null（保留现值），kind 未改传 null", async () => {
    mockLists();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "credentials_update") return Promise.resolve(existing);
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<CredentialForm credential={existing} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("credentials_update", {
        id: 7,
        patch: { kind: null, name: null, secret: null, key_pub: null, passphrase: null, totp_secret: null },
      }),
    );
  });

  it("编辑模式改 kind：patch.kind 带新值", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "credentials_update") return Promise.resolve(existing);
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list" || cmd === "jc_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    render(<CredentialForm credential={existing} onClose={vi.fn()} />);
    setKind("totp");
    fireEvent.change(screen.getByTestId("cred-totp-secret"), { target: { value: "JBSWY3DPEHPK3PXP" } });
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("credentials_update", {
        id: 7,
        patch: expect.objectContaining({ kind: "totp" }),
      }),
    );
  });

  // --- BL-204（终审C-13）改 kind 残留清偿 -------------------------------------
  // Rust patch 语义：null = 保留现值、Some("") = 覆写为空。跨族 kind 变更时
  // 旧族字段必须显式清空（""），否则旧密钥以残留形态挂在新族实体上。

  it("key→password：新密码落地 + 旧 key_pub/passphrase 显式清空（不留残留）", async () => {
    mockLists();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "credentials_update") return Promise.resolve(existing);
      return mockLists();
    });
    const keyCred: Credential = { ...existing, kind: "key", key_pub: "ssh-ed25519 AAAOld" };
    render(<CredentialForm credential={keyCred} onClose={vi.fn()} />);
    setKind("password");
    fireEvent.change(screen.getByTestId("cred-secret"), { target: { value: "new-pass" } });
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("credentials_update", {
        id: 7,
        patch: { kind: "password", name: null, secret: "new-pass", key_pub: "", passphrase: "", totp_secret: "" },
      }),
    );
  });

  it("password→key 跨族：私钥必须重新输入（留空豁免不适用），不发 update", async () => {
    render(<CredentialForm credential={existing} onClose={vi.fn()} />);
    setKind("key");
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("cred-error").textContent).toBe("Private key is required"),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("credentials_update", expect.anything());
  });

  it("password→totp 跨族：totp_secret 必填不豁免；旧 secret 显式清空", async () => {
    mockLists();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "credentials_update") return Promise.resolve(existing);
      return mockLists();
    });
    render(<CredentialForm credential={existing} onClose={vi.fn()} />);
    setKind("totp");
    // 留空提交：豁免不适用 → 拦截
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("cred-error").textContent).toBe("TOTP secret is required"),
    );
    expect(mockedInvoke).not.toHaveBeenCalledWith("credentials_update", expect.anything());

    // 合法输入：secret（旧密码）显式清空为 ""
    fireEvent.change(screen.getByTestId("cred-totp-secret"), { target: { value: "JBSWY3DPEHPK3PXP" } });
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("credentials_update", {
        id: 7,
        patch: { kind: "totp", name: null, secret: "", key_pub: "", passphrase: "", totp_secret: "JBSWY3DPEHPK3PXP" },
      }),
    );
  });

  it("同族切换 password→ftp：留空豁免照旧（secret null 保留现值）", async () => {
    mockLists();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "credentials_update") return Promise.resolve(existing);
      return mockLists();
    });
    render(<CredentialForm credential={existing} onClose={vi.fn()} />);
    setKind("ftp");
    fireEvent.click(screen.getByTestId("cred-submit"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("credentials_update", {
        id: 7,
        patch: { kind: "ftp", name: null, secret: null, key_pub: null, passphrase: null, totp_secret: null },
      }),
    );
  });
});
