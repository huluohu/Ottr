// Git 通道测试（Phase 5 Task 2；评审 Fix round 1）——两层：
//   * 注入 exec 的命令序列单测（clone/show/add/status/commit/push golden、
//     幂等 push、失败面、test 布尔面、I-1 选项注入拒绝面、I-2 filePath 防线、
//     M-1 clone 失败清扫）；push 的信封落盘走真 temp dir（注入 tempDir/cleanup，
//     fs 写不复刻）；
//   * 宿主 git 真 bare 仓库 roundtrip（裁定：不在容器里装 git，宿主 git +
//     本地 bare 路径即真仓库语义——clone/commit/push 全真链）。
//
// 环境前置（评审 Fix round 1 I-3；真链 e2e 不许静默 skip，git 探测失败在
// beforeAll 显式 fail 并给指引）：PATH 里需有 arm64 可解析的 git——macOS 的
// Rosetta/x86_64 git 会因 libxcrun 架构不匹配启动即败（`arch -x86_64 git`
// 复现）；nvm node 前置 PATH 下 git 落 /usr/bin/git（Apple arm64）即正常。
// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealEnvelope } from "./envelope";
import { createGitTransport, nodeGitExec, validateFilePath, validateRepoUrl, type GitExec, type GitExecResult } from "./git";

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
  it("fetch：clone（`--` 分隔符，I-1①）→ show HEAD:<file> golden；文件缺失/空仓库 → null", async () => {
    const work = await realTempDir();
    const { calls, exec } = fakeGit((cmd, call) => {
      if (cmd === "clone") expect(call.args).toEqual(["clone", "--quiet", "--", "/repos/ottr.git", work]);
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
    const t = createGitTransport({ repoUrl: "/repos/x.git" }, { exec: good.exec, tempDir: realTempDir });
    expect(await t.fetch()).toEqual(env);

    const broken = fakeGit((cmd) => (cmd === "show" ? { code: 0, stdout: "not json" } : undefined));
    const t2 = createGitTransport({ repoUrl: "/repos/x.git" }, { exec: broken.exec, tempDir: realTempDir });
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
    const t = createGitTransport({ repoUrl: "/repos/x.git", authorName: "a", authorEmail: "a@x" }, { exec, tempDir: realTempDir });
    await t.push(env);
    expect(calls.map((c) => c.args[0])).toEqual(["clone", "add", "status"]);
  });

  it("push：远端被并发写（非 fast-forward）→ 错误浮出（编排层重试即 last-writer-wins）", async () => {
    const env = await sealEnvelope("data", "pw");
    const { exec } = fakeGit((cmd) =>
      cmd === "push" ? { code: 1, stderr: "! [rejected] main -> main (non-fast-forward)" } : cmd === "status" ? { stdout: "A  f" } : undefined,
    );
    const t = createGitTransport({ repoUrl: "/repos/x.git", authorName: "a", authorEmail: "a@x" }, { exec, tempDir: realTempDir });
    await expect(t.push(env)).rejects.toThrow(/git push failed.*non-fast-forward/);
  });

  it("test：ls-remote（`--` 分隔符）布尔面（0=true/128=false/异常=false）且设 GIT_TERMINAL_PROMPT=0", async () => {
    const okCase = fakeGit((cmd) => (cmd === "ls-remote" ? { stdout: "" } : undefined));
    const t1 = createGitTransport({ repoUrl: "/repos/empty.git" }, { exec: okCase.exec });
    expect(await t1.test()).toBe(true);
    expect(okCase.calls[0]!.args).toEqual(["ls-remote", "--quiet", "--", "/repos/empty.git", "HEAD"]);
    expect(okCase.calls[0]!.env.GIT_TERMINAL_PROMPT).toBe("0");

    const noRepo = fakeGit((cmd) => (cmd === "ls-remote" ? { code: 128, stderr: "does not exist" } : undefined));
    expect(await createGitTransport({ repoUrl: "/nope" }, { exec: noRepo.exec }).test()).toBe(false);

    const throwing: GitExec = async () => {
      throw new Error("spawn ENOENT");
    };
    expect(await createGitTransport({ repoUrl: "/nope2" }, { exec: throwing }).test()).toBe(false);
  });

  it("clone 失败 → 错误浮出（repoUrl 打错等）", async () => {
    const { exec } = fakeGit((cmd) => (cmd === "clone" ? { code: 128, stderr: "repository 'u' does not exist" } : undefined));
    const t = createGitTransport({ repoUrl: "/repos/x.git", authorName: "a", authorEmail: "a@x" }, { exec, tempDir: realTempDir });
    await expect(t.fetch()).rejects.toThrow("git clone failed");
  });

  // -- I-1：repoUrl 选项注入 / 命令传输面拒绝 ---------------------------------

  it("I-1：`-` 开头 repoUrl（--upload-pack 选项注入 PoC）构造时即拒", () => {
    // 评审 PoC 原串：git clone --quiet "--upload-pack=touch /tmp/PWNED-PROOF"
    // 创建了文件——本形态现在到不了 git
    for (const evil of [
      "--upload-pack=touch /tmp/PWNED-PROOF",
      "--upload-pack=touch /tmp/x",
      "-u=touch /tmp/x",
      "-",
    ]) {
      expect(() => createGitTransport({ repoUrl: evil }, { exec: fakeGit(() => undefined).exec }), evil).toThrow(
        /must not start with "-"/,
      );
    }
  });

  it("I-1：命令传输面（ext:: 等）被白名单拒绝；合法形态放行", () => {
    for (const evil of [
      "ext::sh -c touch /tmp/PWNED",
      "ext::git archive --output=/tmp/x HEAD",
      "git+ssh://host/repo.git", // 未知 scheme
      "ftp://host/repo.git",
      "relative/bare.git", // 相对路径（白名单只收绝对）
    ]) {
      expect(() => validateRepoUrl(evil), evil).toThrow(/unsupported repoUrl/);
    }
    expect(() => validateRepoUrl("")).toThrow(/must not be empty/);
    for (const ok of [
      "https://github.com/ottr/sync.git",
      "http://127.0.0.1:3000/user/repo.git",
      "ssh://git@host:2222/srv/repo.git",
      "file:///srv/git/repo.git",
      "/srv/git/bare.git",
      "C:\\repos\\bare",
      "\\\\nas\\git\\bare",
      "git@github.com:ottr/sync.git", // scp-like（ssh 家族，GitHub 事实形态）
    ]) {
      expect(() => validateRepoUrl(ok), ok).not.toThrow();
    }
    // 深度防御实证：合法 scheme 但含可疑子串不被误伤（`--` 分隔符兜底文本化）
    expect(() => validateRepoUrl("https://host/--upload-pack=x")).not.toThrow();
  });

  // -- I-2：filePath `..` 防线 --------------------------------------------------

  it("I-2：filePath 逃逸形态构造时即拒；子目录能力保留", () => {
    for (const evil of [
      "../../../tmp/PWNED",
      "sub/dir/../../out.json",
      "..",
      "a/..",
      "/etc/ottr.json", // 绝对路径
      "back\\slash.json", // `\` 分隔符
      "a//b", // 空组件
      "./x.json",
      "",
    ]) {
      expect(() => validateFilePath(evil), evil).toThrow(/filePath/);
    }
    for (const ok of ["ottr-sync.json", "snapshots/ottr-sync.json", "深度/目录/同步信封.json", ".hidden"]) {
      expect(() => validateFilePath(ok), ok).not.toThrow();
    }
  });

  // -- M-1：freshClone 失败路径清扫 ---------------------------------------------

  it("M-1：clone 失败时临时目录被清扫（不漏 mkdtemp）", async () => {
    const work = await realTempDir();
    const cleaned: string[] = [];
    const { exec } = fakeGit((cmd) => (cmd === "clone" ? { code: 128, stderr: "repository 'u' does not exist" } : undefined));
    const t = createGitTransport({ repoUrl: "/repos/x.git", authorName: "a", authorEmail: "a@x" }, {
      exec,
      tempDir: async () => work,
      cleanup: async (dir) => {
        cleaned.push(dir);
      },
    });
    await expect(t.fetch()).rejects.toThrow("git clone failed");
    expect(cleaned).toEqual([work]);
    await rm(work, { recursive: true, force: true });
  });
});

// -- 宿主 git 真 bare 仓库 roundtrip（唯一 git 通道真跑；fail-loud，见文件头）--

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

  beforeAll(async () => {
    // I-3：探测失败显式 fail（带环境指引），不许静默 skip
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["--version"], { timeout: 10_000 }, (err) => {
        if (!err) return resolve();
        reject(
          new Error(
            "宿主 git 不可用——真链 git e2e 不能静默跳过。环境前置：PATH 需有本机架构可解析的 git" +
              "（macOS 的 Rosetta/x86_64 git 会因 libxcrun 架构不匹配启动即败；" +
              "可 PATH=/usr/bin:$PATH 或指向原生 git 后重跑）：" +
              String(err),
          ),
        );
      });
    });
  });

  it("双设备 roundtrip：A push → B fetch → 密封链 open（真链全走）", async () => {
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
