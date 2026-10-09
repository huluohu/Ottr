// trzsz 真夹具端到端（Phase 2 Task 4，B10 下半）：
//   spike 夹具容器（scripts/spike-sshd.sh 启动，127.0.0.1:2222，镜像内已装
//   trzsz-go v1.2.0 —— fixtures/sshd/Dockerfile 钉版）经 ssh -tt 起 PTY，
//   TrzszController 全链驱动一轮上传 + 一轮下载：
//     上传：controller.uploadFiles([3MB 随机文件]) → 库发 \x03 + "trz\r" →
//           真远端 trz 起协议 → 库分块 base64 经 sendToServer 写 PTY → 完成回执
//     下载：键入 "tsz ~/trzsz-e2e.bin\r" → 库检测魔串 → chooseSaveDirectory →
//           真远端 tsz 推流 → 库分块写盘（node:fs 后端）
//   取证独立通道：远端 sha256sum（exec 于容器）vs 本地 node crypto vs 下载件
//   node crypto，三方一致才算过（与 ottr-transfer sftp_test.rs 同纪律）。
// 夹具不可达 → 立即 fail 并提示启动命令（不引入 testcontainers 的既定裁定）。
// @vitest-environment node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTrzszController, type TrzszController } from "./TrzszController";

const HOST = "127.0.0.1";
const PORT = 2222;
// vitest 的 vite-node 无 import.meta.dirname → fileURLToPath 解析（相对本文件
// frontend/terminal/trzsz/ 上溯 3 级到仓库根）
const ROOT = new URL("../../..", import.meta.url).pathname;
const KEY = join(ROOT, "fixtures/spike_ed25519");
const KNOWN_HOSTS = join(ROOT, "fixtures/known_hosts");
const UPLOAD_BYTES = 3 * 1024 * 1024; // 3MB：跨协议多 chunk（服务端分块协商）

async function fixtureOrPanic() {
  const net = await import("node:net");
  const ok = await new Promise<boolean>((resolve) => {
    const s = net.createConnection({ host: HOST, port: PORT });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(false);
    });
  });
  if (!ok) {
    throw new Error(
      `sshd fixture unreachable at ${HOST}:${PORT} —— 先跑 scripts/spike-sshd.sh（镜像需已重建：含 trzsz-go v1.2.0）`,
    );
  }
}

interface SshSession {
  ssh: ReturnType<typeof spawn>;
  text: string;
  stderrText: string;
  sendToServer: (data: Uint8Array | string) => void;
  controller: TrzszController;
  saveDirs: string[];
  waitOutput: (re: RegExp, timeoutMs: number, what: string) => Promise<void>;
  /** 等「流尾部」匹配（新提示符出现；全文匹配会撞上历史提示符的旧文本） */
  waitTail: (re: RegExp, timeoutMs: number, what: string) => Promise<void>;
}

async function openSsh(): Promise<SshSession> {
  const ssh = spawn(
    "ssh",
    [
      "-tt",
      "-i",
      KEY,
      "-p",
      String(PORT),
      "-o",
      `UserKnownHostsFile=${KNOWN_HOSTS}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "NumberOfPasswordPrompts=0",
      `spike@${HOST}`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const state: SshSession = {
    ssh,
    text: "",
    stderrText: "",
    sendToServer: (data) => {
      if (!ssh.stdin.write(data)) ssh.stdin.once("drain", () => {});
    },
    controller: null as unknown as TrzszController,
    saveDirs: [],
    waitOutput: async () => {},
    waitTail: async () => {},
  };
  ssh.stdout.on("data", (chunk: Buffer) => {
    state.text += chunk.toString("binary");
    state.controller?.processServerOutput(new Uint8Array(chunk));
  });
  ssh.stderr.on("data", (chunk: Buffer) => {
    state.stderrText += chunk.toString();
  });
  const poll = (test: () => boolean, timeoutMs: number, what: string) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (test()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          void import("node:fs/promises")
            .then(({ writeFile }) => writeFile("/tmp/ottr-e2e-debug.txt", state.text))
            .catch(() => {});
          reject(
            new Error(
              `timeout waiting ${what}; tail=${JSON.stringify(state.text.slice(-400))}; stderr=${JSON.stringify(state.stderrText.slice(-300))}`,
            ),
          );
        }
      }, 50);
    });
  state.waitOutput = (re, timeoutMs, what) => poll(() => re.test(state.text), timeoutMs, what);
  state.waitTail = (re, timeoutMs, what) =>
    poll(() => re.test(state.text.slice(-120)), timeoutMs, what);

  state.controller = createTrzszController({
    writeToTerminal: () => {}, // 终端渲染不参与断言（state.text 独立累积）
    sendToServer: (input) => state.sendToServer(input),
    chooseSendFiles: async () => undefined, // e2e 走 uploadFiles 直驱，不经对话框
    chooseSaveDirectory: async () => {
      const dir = await mkdtemp(join(tmpdir(), "ottr-trzsz-dl-"));
      state.saveDirs.push(dir);
      return dir;
    },
    terminalColumns: 120,
    dragInitTimeout: 30_000, // 真网络下等远端 trz banner（默认 3s 太紧）
  });
  return state;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("trzsz 真夹具端到端（trz 上传 + tsz 下载，sha256 三方对拍）", () => {
  let sess: SshSession;
  let uploadDir: string;
  let localSha: string;

  beforeAll(async () => {
    await fixtureOrPanic();
    sess = await openSsh();
    // shell 提示符（登录 shell："spike@<id>:~$ "）；MOTD/横幅之后
    await sess.waitOutput(/\$ $/, 20_000, "shell prompt");
    // 造本地随机文件
    uploadDir = await mkdtemp(join(tmpdir(), "ottr-trzsz-up-"));
    const payload = randomBytes(UPLOAD_BYTES);
    const { writeFile } = await import("node:fs/promises");
    const localPath = join(uploadDir, "trzsz-e2e.bin");
    await writeFile(localPath, payload);
    localSha = createHash("sha256").update(payload).digest("hex");
  }, 30_000);

  afterAll(async () => {
    try {
      sess?.sendToServer("rm -f ~/trzsz-e2e.bin\r");
      await new Promise((r) => setTimeout(r, 300));
    } catch {
      /* 收尾尽力 */
    }
    sess?.ssh.kill("SIGKILL");
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
    for (const d of sess?.saveDirs ?? []) await rm(d, { recursive: true, force: true });
  }, 10_000);

  it(
    "uploadFiles → 远端 trz 收货（remote sha256sum 对上）",
    { timeout: 120_000 },
    async () => {
      const localPath = join(uploadDir, "trzsz-e2e.bin");
      // 前置：远端无同名残留
      sess.sendToServer("rm -f ~/trzsz-e2e.bin\r");
      await sess.waitTail(/\$ $/, 10_000, "cleanup prompt");
      await sess.controller.uploadFiles([localPath]); // 3MB 上传全链（真协议）
      // uploadFiles 在 clientExit 发出即 resolve；远端 trz 收尾/恢复 tty 有滞后，
      // 立即键入会被 trz 吞掉 —— 等新提示符出现在流尾部再敲命令
      await sess.waitTail(/\$ $/, 30_000, "post-upload prompt");
      await new Promise((r) => setTimeout(r, 500));
      // 远端独立取证：sha256sum 于容器内
      sess.sendToServer("sha256sum ~/trzsz-e2e.bin\r");
      await sess.waitOutput(
        /([0-9a-f]{64})[ \t]+\/home\/spike\/trzsz-e2e\.bin/,
        30_000,
        "remote sha256sum",
      );
      const remoteSha = /([0-9a-f]{64})[ \t]+\/home\/spike\/trzsz-e2e\.bin/.exec(sess.text)![1];
      expect(remoteSha).toBe(localSha);
    },
  );

  it(
    "键入 tsz → 库接住魔串 → chooseSaveDirectory 落盘（下载件 sha256 对上）",
    { timeout: 120_000 },
    async () => {
      sess.sendToServer("tsz ~/trzsz-e2e.bin\r");
      // chooseSaveDirectory 恰被调一次（下载对答）；传输结束回到提示符
      await sess.waitTail(/\$ $/, 60_000, "download done prompt");
      expect(sess.controller.isTransferring()).toBe(false);
      expect(sess.saveDirs.length).toBe(1);
      const names = await readdir(sess.saveDirs[0]);
      const saved = names.find((n) => n.startsWith("trzsz-e2e.bin"));
      expect(saved).toBeTruthy();
      const downloadedSha = await sha256File(join(sess.saveDirs[0], saved!));
      expect(downloadedSha).toBe(localSha);
    },
  );
});
