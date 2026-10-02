// Git 同步通道（Phase 5 Task 2）——shell 调用系统 git（裁定实录：不引入
// git2 crate/JS 实现，零新依赖；系统 git 的凭据体系直接复用）。
//
// 依赖文档化（计划「诚实边界」条款）：本通道要求宿主装有 git（PATH 可见，
// macOS=Command Line Tools 自带；Linux=发行版包管理器）。webview 生产接线
// 需宿主 exec 桥（Rust 侧尚无通用 shell 命令——fsShim 先例：先交付可注入
// 后端与 node 实现，Tauri 桥在 UI 接线任务补）；vitest/端到端经 nodeGitExec
// 走宿主 git。
//
// 每次 fetch/push 都在全新临时目录 clone（无本地常驻工作副本）：
//   * fetch：clone → 读文件（缺 = null，空仓库 clone 也成功）→ 信封校验；
//   * push：clone → 写文件 → add → （有差异才）commit → push HEAD:refs/heads/
//     <branch>（显式 refspec 免空仓库分支歧义）。clone 恒基于远端最新态，
//     推送失败只剩「clone 与 push 之间远端又被写」的窄窗竞态——非 fast-forward
//     时 git 拒绝并报错，编排层重试即 last-writer-wins（契约文件头声明）；
//   * test：git ls-remote <url>（不 clone，空仓库同样 code 0）。
//
// 凭据取舍（报告披露）：repoUrl 由用户配置——
//   * 推荐路径：系统 credential helper（osxkeychain/store/manager-core），
//     Ottr 不经手 token；本实现恒设 GIT_TERMINAL_PROMPT=0（交互式终端凭据
//     提示在无 TTY 环境只会挂起，禁掉后失败立即浮现）；
//   * 可选路径：URL 内嵌 https://user:token@host/repo.git——token 会短暂落在
//     临时 clone 的 .git/config（用完即删的 mkdtemp，进程退出即消失）与 git
//     进程参数（本机 ps 可见窗口）；便利换暴露面，用户显式选择才可用。
import { parseEnvelopeJson, type SyncTransport } from "./transport";
import type { SyncEnvelope } from "./envelope";

export interface GitConfig {
  /** 远端（本地 bare 仓库路径或任何 git URL；可含凭据——取舍见文件头）。 */
  repoUrl: string;
  /** 仓库内信封文件路径（缺省 ottr-sync.json）。 */
  filePath?: string;
  /** 目标分支（缺省 main；push 用显式 refspec HEAD:refs/heads/<branch>）。 */
  branch?: string;
  /** commit 作者（缺省吃系统 git config；测试恒显式给，免环境依赖）。 */
  authorName?: string;
  authorEmail?: string;
}

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 宿主 exec 后端：跑 git 子命令（cwd + 额外 env 由实现合并）。 */
export type GitExec = (args: string[], opts: { cwd?: string; env?: Record<string, string> }) => Promise<GitExecResult>;

export interface GitDeps {
  exec?: GitExec;
  /** 临时目录（缺省 node:fs mkdtemp；测试可注入收纳点）。 */
  tempDir?: () => Promise<string>;
  now?: () => number;
  /** 工作目录清扫（缺省 node:fs rm -rf；测试注入 no-op 断言内容）。 */
  cleanup?: (dir: string) => Promise<void>;
}

const DEFAULT_BRANCH = "main";
const DEFAULT_FILE_PATH = "ottr-sync.json";

/** node 后端（vitest/端到端；webview 生产需宿主 exec 桥，见文件头）。 */
export function nodeGitExec(): GitExec {
  return (args, opts) =>
    (async () => {
      const { execFile } = (await import("node:child_process")) as typeof import("node:child_process");
      const env = { GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) };
      return new Promise<GitExecResult>((resolve, reject) => {
        execFile(
          "git",
          args,
          { cwd: opts.cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
          (err, stdout, stderr) => {
            if (err && (err as { code?: number }).code === undefined) reject(err);
            else resolve({ code: Number((err as { code?: number } | null)?.code ?? 0), stdout: String(stdout), stderr: String(stderr) });
          },
        );
      });
    })();
}

/** 临时目录 + 清扫的 node 实现（动态 import 免 webview 打包 node 内置）。 */
async function nodeTempDir(): Promise<string> {
  const fsp = (await import("node:fs/promises")) as typeof import("node:fs/promises");
  const os = (await import("node:os")) as typeof import("node:os");
  const path = (await import("node:path")) as typeof import("node:path");
  return fsp.mkdtemp(path.join(os.tmpdir(), "ottr-sync-git-"));
}

async function nodeCleanup(dir: string): Promise<void> {
  const fsp = (await import("node:fs/promises")) as typeof import("node:fs/promises");
  await fsp.rm(dir, { recursive: true, force: true });
}

function fail(op: string, res: GitExecResult): Error {
  return new Error(`git ${op} failed (code ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
}

export function createGitTransport(config: GitConfig, deps: GitDeps = {}): SyncTransport {
  const exec = deps.exec ?? nodeGitExec();
  const tempDir = deps.tempDir ?? nodeTempDir;
  const cleanup = deps.cleanup ?? nodeCleanup;
  const branch = config.branch ?? DEFAULT_BRANCH;
  const filePath = config.filePath ?? DEFAULT_FILE_PATH;

  /** 统一出口：恒设 GIT_TERMINAL_PROMPT=0（交互式凭据提示在无 TTY 只会挂起）。 */
  async function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<GitExecResult> {
    const res = await exec(args, { cwd: opts.cwd, env: { GIT_TERMINAL_PROMPT: "0", ...(opts.env ?? {}) } });
    if (res.code !== 0) throw fail(args[0] ?? "git", res);
    return res;
  }

  /** 只探错误码不抛的调用（show/status 等以退出码为语义的读面）。 */
  async function probe(args: string[], cwd?: string): Promise<GitExecResult> {
    return exec(args, { cwd, env: { GIT_TERMINAL_PROMPT: "0" } });
  }

  const commitEnv = (): Record<string, string> =>
    config.authorName !== undefined || config.authorEmail !== undefined
      ? {
          GIT_AUTHOR_NAME: config.authorName ?? "",
          GIT_AUTHOR_EMAIL: config.authorEmail ?? "",
          GIT_COMMITTER_NAME: config.authorName ?? "",
          GIT_COMMITTER_EMAIL: config.authorEmail ?? "",
        }
      : {};

  /** clone 到一次性工作目录；调用方负责 finally 清扫。 */
  async function freshClone(): Promise<string> {
    const work = await tempDir();
    await run(["clone", "--quiet", config.repoUrl, work]);
    return work;
  }

  return {
    kind: "git",

    async fetch(): Promise<SyncEnvelope | null> {
      const work = await freshClone();
      try {
        const res = await probe(["show", `HEAD:${filePath}`], work);
        if (res.code !== 0) return null; // 文件尚未入库（首次/空仓库）
        return parseEnvelopeJson(res.stdout);
      } finally {
        await cleanup(work);
      }
    },

    async push(envelope: SyncEnvelope): Promise<void> {
      const work = await freshClone();
      try {
        const fsp = (await import("node:fs/promises")) as typeof import("node:fs/promises");
        const path = (await import("node:path")) as typeof import("node:path");
        await fsp.writeFile(path.join(work, filePath), JSON.stringify(envelope), "utf8");
        await run(["add", "--", filePath], { cwd: work });
        const status = await probe(["status", "--porcelain"], work);
        if (status.stdout.trim() !== "") {
          // 有差异才 commit：同信封重复 push 幂等（no-op）
          const msg = `ottr sync ${new Date((deps.now ?? Date.now)()).toISOString()}`;
          await run(["commit", "--quiet", "-m", msg], { cwd: work, env: commitEnv() });
          await run(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { cwd: work });
        }
      } finally {
        await cleanup(work);
      }
    },

    async test(): Promise<boolean> {
      try {
        const res = await exec(["ls-remote", "--quiet", config.repoUrl, "HEAD"], { env: { GIT_TERMINAL_PROMPT: "0" } });
        return res.code === 0;
      } catch {
        return false;
      }
    },
  };
}
