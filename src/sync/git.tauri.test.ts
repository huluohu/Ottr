// tauriGitDeps 接线测试（Phase 5 Task 4）：webview 生产 exec 桥（Rust
// commands/sync_git.rs 白名单命令）的参数映射——
//   * exec：argv 原样透传（形状校验在 Rust 权威侧）、cwd 省缺 → null、
//     commit 作者 env → 显式 authorName/authorEmail 参数；
//   * tempDir/writeFile/cleanup：命令名与 Rust 注册逐字对齐，writeFile 拼
//     绝对路径（workDir + "/" + relPath，剥尾斜杠）；
//   * 穿 createGitTransport 真 push 链：clone(cwd=null) → write → add →
//     status → commit(作者参数) → push → cleanup 全序断言。
// Rust 侧形状钉死/白名单的拒绝面在 sync_git.rs 单测（权威边界在那边）。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const mockedInvoke = invoke as unknown as Mock;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { createGitTransport, tauriGitDeps, type SyncEnvelope } from "./git";
import type { GitExecResult } from "./git";

const ENVELOPE: SyncEnvelope = {
  "ottr-sync": 1,
  kdf: { alg: "pbkdf2-sha256", salt: "abc", iterations: 310_000 },
  nonce: "n0nce",
  ciphertext: "c1ph3r",
};

function ok(code = 0, stdout = ""): GitExecResult {
  return { code, stdout, stderr: "" };
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tauriGitDeps", () => {
  it("exec：argv 原样 + cwd 透传；author env 映射为显式参数（无作者 → null）", async () => {
    mockedInvoke.mockResolvedValue(ok());
    const deps = tauriGitDeps();
    await deps.exec!(["status", "--porcelain"], { cwd: "/tmp/ottr-sync-git-1" });
    expect(mockedInvoke).toHaveBeenCalledWith("sync_git_exec", {
      args: ["status", "--porcelain"],
      cwd: "/tmp/ottr-sync-git-1",
      authorName: null,
      authorEmail: null,
    });
    await deps.exec!(["commit", "--quiet", "-m", "ottr sync"], {
      cwd: "/tmp/ottr-sync-git-1",
      env: { GIT_AUTHOR_NAME: "Ottr", GIT_COMMITTER_NAME: "Ottr", GIT_AUTHOR_EMAIL: "o@x", GIT_COMMITTER_EMAIL: "o@x" },
    });
    expect(mockedInvoke).toHaveBeenLastCalledWith("sync_git_exec", {
      args: ["commit", "--quiet", "-m", "ottr sync"],
      cwd: "/tmp/ottr-sync-git-1",
      authorName: "Ottr",
      authorEmail: "o@x",
    });
  });

  it("scratch 三命令与 Rust 注册名逐字对齐；writeFile 拼绝对路径剥尾斜杠", async () => {
    mockedInvoke.mockImplementation((_cmd: string, args: { path?: string }) => {
      if (args?.path !== undefined) return Promise.resolve(); // write
      return Promise.resolve("/tmp/ottr-sync-git-9/");
    });
    const deps = tauriGitDeps();
    const dir = await deps.tempDir!();
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, "sync_git_scratch", undefined);
    await deps.writeFile!(dir, "snapshots/ottr-sync.json", "{}");
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      2,
      "sync_git_scratch_write",
      { path: "/tmp/ottr-sync-git-9/snapshots/ottr-sync.json", data: "{}" },
    );
    await deps.cleanup!(dir);
    expect(mockedInvoke).toHaveBeenNthCalledWith(3, "sync_git_scratch_cleanup", {
      dir: "/tmp/ottr-sync-git-9/",
    });
  });

  it("穿 createGitTransport 真 push 链：命令全序 + clone 无 cwd + 落盘内容", async () => {
    let work = "";
    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "sync_git_scratch") {
        work = "/tmp/ottr-sync-git-it";
        return Promise.resolve(work);
      }
      if (cmd === "sync_git_scratch_write") {
        return Promise.resolve();
      }
      if (cmd === "sync_git_exec") {
        const sub = (args!.args as string[])[0];
        if (sub === "show") return Promise.resolve(ok(1)); // 无历史
        if (sub === "status") return Promise.resolve(ok(0, "A  ottr-sync.json")); // 有差异
        return Promise.resolve(ok());
      }
      if (cmd === "sync_git_scratch_cleanup") return Promise.resolve();
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const t = createGitTransport(
      { repoUrl: "https://h/r.git", branch: "sync", authorName: "A", authorEmail: "a@x" },
      tauriGitDeps(),
    );
    await t.push(ENVELOPE);

    const cmds = mockedInvoke.mock.calls.map((c) => c[0]);
    expect(cmds).toEqual([
      "sync_git_scratch",
      "sync_git_exec", // clone
      "sync_git_scratch_write",
      "sync_git_exec", // add
      "sync_git_exec", // status
      "sync_git_exec", // commit
      "sync_git_exec", // push
      "sync_git_scratch_cleanup",
    ]);
    const clone = mockedInvoke.mock.calls[1]![1];
    expect(clone).toEqual({
      args: ["clone", "--quiet", "--", "https://h/r.git", work],
      cwd: null,
      authorName: null,
      authorEmail: null,
    });
    const write = mockedInvoke.mock.calls[2]![1];
    expect(write.path).toBe(`${work}/ottr-sync.json`);
    expect(write.data).toBe(JSON.stringify(ENVELOPE));
    const commit = mockedInvoke.mock.calls[5]![1];
    expect(commit.args).toEqual(["commit", "--quiet", "-m", expect.stringMatching(/^ottr sync /)]);
    expect(commit.authorName).toBe("A");
    const push = mockedInvoke.mock.calls[6]![1];
    expect(push.args).toEqual(["push", "--quiet", "origin", "HEAD:refs/heads/sync"]);
  });

  it("test()：ls-remote 形态经桥；Rust 拒绝（抛错）→ false", async () => {
    mockedInvoke.mockResolvedValueOnce(ok());
    const t = createGitTransport({ repoUrl: "git@h:r.git" }, tauriGitDeps());
    await expect(t.test()).resolves.toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("sync_git_exec", {
      args: ["ls-remote", "--quiet", "--", "git@h:r.git", "HEAD"],
      cwd: null,
      authorName: null,
      authorEmail: null,
    });

    mockedInvoke.mockReset().mockRejectedValueOnce(new Error("sync-git: argv shape not allowed"));
    const t2 = createGitTransport({ repoUrl: "git@h:r.git" }, tauriGitDeps());
    await expect(t2.test()).resolves.toBe(false);
  });
});
