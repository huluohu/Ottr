// SyncSettings 组件测试（Phase 5 Task 4）：通道三选一配置的加载/校验/落库、
// 测试连接（草稿面真 transport：webdav 走 stub fetch，git 走 invoke 桥断言
// token 内嵌）、信封口令设置/更换/清除（keyring 命令）、立即同步入口门控。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.hoisted(() => {
  Object.defineProperty(window.navigator, "language", {
    value: "zh-CN",
    configurable: true,
  });
});

const mockedInvoke = invoke as unknown as Mock;
const dialogOpen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => dialogOpen(...a) }));

import "../i18n";
import { SYNC_CHANNEL_KEY, SyncSettings, syncConfigKey } from "./SyncSettings";

function seedSettings(map: Record<string, unknown>) {
  mockedInvoke.mockImplementation((cmd: string, args?: { key?: string; value?: unknown }) => {
    if (cmd === "settings_get") return Promise.resolve((map as Record<string, unknown>)[args?.key ?? ""] ?? null);
    if (cmd === "settings_set") return Promise.resolve();
    if (cmd === "sync_passphrase_get") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

function renderSection(onOpenSync = vi.fn()) {
  const result = render(<SyncSettings onOpenSync={onOpenSync} />);
  return { onOpenSync, unmount: result.unmount };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  dialogOpen.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SyncSettings", () => {
  it("加载已保存配置：表单回填、通道选中、立即同步可用；无配置 → 立即同步禁用", async () => {
    seedSettings({
      [SYNC_CHANNEL_KEY]: "webdav",
      [syncConfigKey("webdav")]: { server: "https://dav.x", remotePath: "s.json", username: "u", password: "p" },
    });
    const { unmount } = renderSection();    await waitFor(() => expect((screen.getByTestId("sync-webdav-server") as HTMLInputElement).value).toBe("https://dav.x"));
    expect((screen.getByTestId("sync-channel-webdav") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("sync-now") as HTMLButtonElement).disabled).toBe(false);
    unmount();

    seedSettings({});
    renderSection();
    await waitFor(() => expect((screen.getByTestId("sync-now") as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("sync-need-channel")).toBeTruthy();
  });

  it("webdav：非 http(s) 服务器 → 校验错误且不落库；合法配置保存写 channel+config 两键", async () => {
    seedSettings({});
    renderSection();
    await waitFor(() => expect(screen.getByTestId("sync-channel-webdav")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync-channel-webdav"));
    fireEvent.change(screen.getByTestId("sync-webdav-server"), { target: { value: "ftp://nope" } });
    fireEvent.click(screen.getByTestId("sync-save"));
    expect(screen.getByTestId("sync-form-error").textContent).toContain("http");
    expect(mockedInvoke).not.toHaveBeenCalledWith("settings_set", expect.objectContaining({ key: SYNC_CHANNEL_KEY }));

    fireEvent.change(screen.getByTestId("sync-webdav-server"), { target: { value: "https://dav.x" } });
    fireEvent.click(screen.getByTestId("sync-save"));
    await waitFor(() => expect(screen.getByTestId("sync-save").textContent).toContain("已保存"));
    expect(mockedInvoke).toHaveBeenCalledWith("settings_set", { key: SYNC_CHANNEL_KEY, value: "webdav" });
    expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
      key: syncConfigKey("webdav"),
      value: { server: "https://dav.x", remotePath: "", username: "", password: "" },
    });
  });

  it("git：repoUrl 注入形态拒绝；合法 https + token → 测试连接经桥且 URL 内嵌 token", async () => {
    seedSettings({});
    renderSection();
    await waitFor(() => expect(screen.getByTestId("sync-channel-git")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync-channel-git"));
    fireEvent.change(screen.getByTestId("sync-git-repourl"), { target: { value: "ext::sh -c x" } });
    fireEvent.click(screen.getByTestId("sync-save"));
    expect(screen.getByTestId("sync-form-error").textContent).toContain("scheme");

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "sync_git_exec") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      if (cmd === "settings_get") return Promise.resolve(null);
      if (cmd === "sync_passphrase_get") return Promise.resolve(null);
      return Promise.resolve();
    });
    fireEvent.change(screen.getByTestId("sync-git-repourl"), { target: { value: "https://github.com/u/r.git" } });
    fireEvent.change(screen.getByTestId("sync-git-token"), { target: { value: "T0K" } });
    fireEvent.click(screen.getByTestId("sync-test"));
    await waitFor(() => expect(screen.getByTestId("sync-test-result").textContent).toContain("连接正常"));
    expect(mockedInvoke).toHaveBeenCalledWith("sync_git_exec", {
      args: ["ls-remote", "--quiet", "--", "https://oauth2:T0K@github.com/u/r.git", "HEAD"],
      cwd: null,
      authorName: null,
      authorEmail: null,
    });
  });

  it("webdav 测试连接：fetch 2xx → 连接正常；401 → 连接失败", async () => {
    seedSettings({});
    renderSection();
    await waitFor(() => expect(screen.getByTestId("sync-channel-webdav")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync-channel-webdav"));
    fireEvent.change(screen.getByTestId("sync-webdav-server"), { target: { value: "https://dav.x" } });

    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(screen.getByTestId("sync-test"));
    await waitFor(() => expect(screen.getByTestId("sync-test-result").textContent).toContain("连接正常"));

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    fireEvent.click(screen.getByTestId("sync-test"));
    await waitFor(() => expect(screen.getByTestId("sync-test-result").textContent).toContain("连接失败"));
    vi.unstubAllGlobals();
  });

  it("localdir：系统目录框选定 → 草稿回填并可保存", async () => {
    seedSettings({});
    dialogOpen.mockResolvedValue("/Users/me/syncdir");
    renderSection();
    await waitFor(() => expect(screen.getByTestId("sync-channel-localdir")).toBeTruthy());
    fireEvent.click(screen.getByTestId("sync-channel-localdir"));
    fireEvent.click(screen.getByTestId("sync-localdir-choose"));
    await waitFor(() => expect(screen.getByTestId("sync-localdir-dir").textContent).toBe("/Users/me/syncdir"));
    fireEvent.click(screen.getByTestId("sync-save"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("settings_set", {
        key: syncConfigKey("localdir"),
        value: { dir: "/Users/me/syncdir" },
      }),
    );
  });

  it("Minor-2：草稿未保存 → 立即同步旁 hint「更改保存后生效」，保存后消失", async () => {
    seedSettings({
      [SYNC_CHANNEL_KEY]: "webdav",
      [syncConfigKey("webdav")]: { server: "https://dav.x", remotePath: "", username: "", password: "" },
    });
    renderSection();
    await waitFor(() => expect((screen.getByTestId("sync-webdav-server") as HTMLInputElement).value).toBe("https://dav.x"));
    expect(screen.queryByTestId("sync-dirty-hint")).toBeNull();
    fireEvent.change(screen.getByTestId("sync-webdav-server"), { target: { value: "https://dav.y" } });
    expect(screen.getByTestId("sync-dirty-hint")).toBeTruthy();
    fireEvent.click(screen.getByTestId("sync-save"));
    await waitFor(() => expect(screen.queryByTestId("sync-dirty-hint")).toBeNull());
  });

  it("信封口令：未设置 → 设置表单（不一致报错/成功写钥匙链）；已设置 → 更换+清除", async () => {
    seedSettings({});
    renderSection();
    await waitFor(() => expect(screen.getByTestId("sync-passphrase-status").textContent).toContain("未设置"));
    fireEvent.click(screen.getByTestId("sync-passphrase-toggle"));
    fireEvent.change(screen.getByTestId("sync-passphrase-new"), { target: { value: "abc" } });
    fireEvent.change(screen.getByTestId("sync-passphrase-confirm"), { target: { value: "abd" } });
    fireEvent.click(screen.getByTestId("sync-passphrase-submit"));
    expect(screen.getByTestId("sync-passphrase-error").textContent).toContain("不一致");

    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "sync_passphrase_set") {
        expect(args?.value).toBe("abc");
        return Promise.resolve();
      }
      if (cmd === "settings_get" || cmd === "sync_passphrase_get") return Promise.resolve(null);
      return Promise.resolve();
    });
    fireEvent.change(screen.getByTestId("sync-passphrase-confirm"), { target: { value: "abc" } });
    fireEvent.click(screen.getByTestId("sync-passphrase-submit"));
    await waitFor(() => expect(screen.getByTestId("sync-passphrase-status").textContent).toContain("已存钥匙链"));
    expect(screen.getByTestId("sync-passphrase-forget")).toBeTruthy();

    fireEvent.click(screen.getByTestId("sync-passphrase-forget"));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("sync_passphrase_del"));
    await waitFor(() => expect(screen.getByTestId("sync-passphrase-status").textContent).toContain("未设置"));
  });
});
