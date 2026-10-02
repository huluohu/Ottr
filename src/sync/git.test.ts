// Git 通道测试（Phase 5 Task 2）——两层：
//   * 注入 exec 的命令序列单测（clone/show/add/status/commit/push golden、
//     幂等 push、失败面、test 布尔面）；push 的信封落盘走真 temp dir
//     （注入 tempDir/cleanup，fs 写不复刻）；
//   * 宿主 git 真 bare 仓库 roundtrip（裁定：不在容器里装 git，宿主 git +
//     本地 bare 路径即真仓库语义——clone/commit/push 全真链）。
// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sealEnvelope } from "./envelope";
import { createGitTransport, nodeGitExec, type GitExec, type GitExecResult } from "./git";

// -- 注入 exec 假件（按子命令分派的记录器；tempDir 真目录供信封落盘） ---------

interface RecordedCall {
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}

function fakeGit(script: (cmd: string, call: RecordedCall) => Partial<GitExecResult> | undefined) {
  const calls: RecordedCall[] = [];
  const exec: GitExec = async (args, opts) => {
    const call: RecordedCall = { args, cwd: opts.cwd, env: opts.env ?? {} };
    calls.push(call);
    const res = script(args[0] ?? "", call) ?? {};
    return { code: 0, stdout: "", stderr: "", ...res };
  };
  return { calls, exec };
}

async function realTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ottr-sync-git-fake-"));
}

describe("Git 通道（注入 exec）", () => {
  it("fetch：clone → show HEAD:<file> golden；文件缺失/空仓库 → null", async () => {
    const work = await realTempDir();
    const { calls, exec } = fakeGit((cmd, call) => {
      if (cmd === "clone") expect(call.args).toEqual(["clone", "--quiet", "/repos/ottr.git", work]);
      if (cmd === "show") {
        expect(call.args).toEqual(["show", "HEAD:ottr-sync.json"]);
        expect(call.cwd).toBe(work);
        return { code: 128, stderr: "fatal: path 'ottr-sync.json' does not exist in 'HEAD'" };
      }
      return undefined;
    });
    const t = createGitTransport({ repoUrl: "/repos/ottr.git" }, {
      exec,
      tempDir: async () => work,
      cleanup: async () => undefined,
    });
    expect(await t.fetch()).toBeNull();
    expect(calls.map((c) => c.args[0])).toEqual(["clone", "show"]);
    await rm(work, { recursive: true, force: true });
  });

  it("fetch：show 出 JSON → 信封解析（损坏 JSON 抛错浮出）", async () => {
    const env = await sealEnvelope("{}", "pw");
    const good = fakeGit((cmd) => (cmd === "show" ? { stdout: JSON.stringify(env) } : undefined));
    const t = createGitTransport({ repoUrl: "u" }, { exec: good.exec, tempDir: realTempDir });
    expect(await t.fetch()).toEqual(env);

    const broken = fakeGit((cmd) => (cmd === "show" ? { code: 0, stdout: "not json" } : undefined));
    const t2 = createGitTransport({ repoUrl: "u" }, { exec: broken.exec, tempDir: realTempDir });
    await expect(t2.fetch()).rejects.toThrow("not valid JSON");
  });

  it("push：clone → add → status 非空 → commit（作者 env + PROMPT=0）→ push 显式 refspec golden", async () => {
    const env = await sealEnvelope("data", "pw");
    const { calls, exec } = fakeGit((cmd) => (cmd === "status" ? { stdout: "A  ottr-sync.json\n" } : undefined));
    const t = createGitTransport(
      { repoUrl: "/repos/ottr.git", branch: "sync", authorName: "device-a", authorEmail: "a@x" },
      { exec, tempDir: realTempDir },
    );
    await t.push(env);

    expect(calls.map((c) => c.args[0])).toEqual(["clone", "add", "status", "commit", "push"]);
    expect(calls[0]!.env.GIT_TERMINAL_PROMPT).toBe("0");
    const add = calls[1]!;
    expect(add.args).toEqual(["add", "--", "ottr-sync.json"]);
    const commit = calls[3]!;
    expect(commit.env.GIT_AUTHOR_NAME).toBe("device-a");
    expect(commit.env.GIT_AUTHOR_EMAIL).toBe("a@x");
    expect(commit.env.GIT_COMMITTER_NAME).toBe("device-a");
    expect(commit.env.GIT_COMMITTER_EMAIL).toBe("a@x");
    expect(commit.args).toContain("-m");
    const push = calls[4]!;
    expect(push.args).toEqual(["push", "--quiet", "origin", "HEAD:refs/heads/sync"]);
  });

  it("push：status 干净（同信封重推）→ 不 commit 不 push（幂等）", async () => {
    const env = await sealEnvelope("data", "pw");
    const { calls, exec } = fakeGit((cmd) => (cmd === "status" ? { stdout: "" } : undefined));
    const t = createGitTransport({ repoUrl: "u", authorName: "a", authorEmail: "a@x" }, { exec, tempDir: realTempDir });
    await t.push(env);
    expect(calls.map((c) => c.args[0])).toEqual(["clone", "add", "status"]);
  });

  it("push：远端被并发写（非 fast-forward）→ 错误浮出（编排层重试即 last-writer-wins）", async () => {
    const env = await sealEnvelope("data", "pw");
    const { exec } = fakeGit((cmd) =>
      cmd === "push" ? { code: 1, stderr: "! [rejected] main -> main (non-fast-forward)" } : cmd === "status" ? { stdout: "A  f" } : undefined,
    );
    const t = createGitTransport({ repoUrl: "u", authorName: "a", authorEmail: "a@x" }, { exec, tempDir: realTempDir });
    await expect(t.push(env)).rejects.toThrow(/git push failed.*non-fast-forward/);
  });

  it("test：ls-remote 布尔面（0=true/128=false/异常=false）且设 GIT_TERMINAL_PROMPT=0", async () => {
    const okCase = fakeGit((cmd) => (cmd === "ls-remote" ? { stdout: "" } : undefined));
    const t1 = createGitTransport({ repoUrl: "/repos/empty.git" }, { exec: okCase.exec });
    expect(await t1.test()).toBe(true);
    expect(okCase.calls[0]!.args).toEqual(["ls-remote", "--quiet", "/repos/empty.git", "HEAD"]);
    expect(okCase.calls[0]!.env.GIT_TERMINAL_PROMPT).toBe("0");

    const noRepo = fakeGit((cmd) => (cmd === "ls-remote" ? { code: 128, stderr: "does not exist" } : undefined));
    expect(await createGitTransport({ repoUrl: "/nope" }, { exec: noRepo.exec }).test()).toBe(false);

    const throwing: GitExec = async () => {
      throw new Error("spawn ENOENT");
    };
    expect(await createGitTransport({ repoUrl: "u" }, { exec: throwing }).test()).toBe(false);
  });

  it("clone 失败 → 错误浮出（repoUrl 打错等）", async () => {
    const { exec } = fakeGit((cmd) => (cmd === "clone" ? { code: 128, stderr: "repository 'u' does not exist" } : undefined));
    const t = createGitTransport({ repoUrl: "u", authorName: "a", authorEmail: "a@x" }, { exec, tempDir: realTempDir });
    await expect(t.fetch()).rejects.toThrow("git clone failed");
  });
});

// -- 宿主 git 真 bare 仓库 roundtrip ------------------------------------------

const hasGit = await new Promise<boolean>((resolve) => {
  execFile("git", ["--version"], (err) => resolve(!err));
});

describe("Git 通道（宿主 git 真 bare 仓库）", () => {
  const roots: string[] = [];

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "ottr-sync-git-test-"));
    roots.push(root);
    return root;
  }

  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  it.skipIf(!hasGit)("双设备 roundtrip：A push → B fetch → 密封链 open", async () => {
    const root = await makeRoot();
    const bare = join(root, "origin.git");
    await new Promise<void>((resolve, reject) =>
      execFile("git", ["init", "--bare", "--initial-branch=main", bare], (e) => (e ? reject(e) : resolve())),
    );

    const deviceA = createGitTransport(
      { repoUrl: bare, authorName: "device-a", authorEmail: "a@ottr.test" },
      { exec: nodeGitExec() },
    );
    const deviceB = createGitTransport(
      { repoUrl: bare, authorName: "device-b", authorEmail: "b@ottr.test" },
      { exec: nodeGitExec() },
    );

    // 空仓库：fetch = null（首次同步），test = true
    expect(await deviceB.fetch()).toBeNull();
    expect(await deviceB.test()).toBe(true);

    // A 密封推送 → B 拉到同一信封 → 口令开封还原明文
    const sealed = await sealEnvelope('{"hosts":["web-01"]}', "sync-pass");
    await deviceA.push(sealed);
    const got = await deviceB.fetch();
    expect(got).toEqual(sealed);
    const { openEnvelope } = await import("./envelope");
    expect(new TextDecoder().decode(await openEnvelope(got, "sync-pass"))).toBe('{"hosts":["web-01"]}');

    // B 修改再推（覆盖语义）→ A 拉到 B 版（last-writer-wins 声明的正路）
    const sealed2 = await sealEnvelope('{"hosts":["web-01","db-01"]}', "sync-pass");
    await deviceB.push(sealed2);
    expect(await deviceA.fetch()).toEqual(sealed2);

    // 幂等：同信封重推 no-op（clone 后 status 干净）
    await deviceA.push(sealed2);
    expect(await deviceA.fetch()).toEqual(sealed2);
  }, 30_000);
});
