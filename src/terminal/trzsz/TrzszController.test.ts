// TrzszController 单测（Phase 2 Task 4）：require 垫片钉 node 模式、空闲透传、
// 魔串跨块留验（前缀后缀 + 完整 banner 载荷截断）、下载激活（chooseSaveDirectory
// 对答）、传输中止（Ctrl-C）、主动上传启动序列（Ctrl-C + trz\r）、坏路径 onError
// 上抛、dispose 断流。协议对端不在这里造（真协议走 e2e.trzsz.test.ts 夹具）。
//
// node 环境（非 jsdom）：trzsz 库对入参做 instanceof ArrayBuffer/Uint8Array 判别
// （findTrzszMagicKey），jsdom realm 的 TypedArray 跨 realm instanceof 恒 false
// → 魔串识别失效；node 环境下同 realm，生产行为等价（webview 单 realm）。
// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./requireShim";
import { TrzszFilter } from "trzsz";
import {
  createTrzszController,
  magicHoldLength,
  partialMagicSuffixLength,
  type TrzszControllerOptions,
} from "./TrzszController";

function makeOpts(over: Partial<TrzszControllerOptions> = {}): TrzszControllerOptions & {
  __written: (Uint8Array | string)[];
  __sent: (Uint8Array | string)[];
} {
  const __written: (Uint8Array | string)[] = [];
  const __sent: (Uint8Array | string)[] = [];
  return {
    __written,
    __sent,
    writeToTerminal: (out) => void __written.push(out),
    sendToServer: (input) => void __sent.push(input),
    chooseSendFiles: async () => undefined,
    chooseSaveDirectory: async () => undefined,
    terminalColumns: 80,
    dragInitTimeout: 150,
    ...over,
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sentText(sent: (Uint8Array | string)[]): string {
  return sent.map((s) => (typeof s === "string" ? s : decoder.decode(s))).join("");
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("require 垫片（node 模式钉死）", () => {
  it("globalThis.require 已安装且 resolve('fs') === 'fs'", async () => {
    const req = (globalThis as unknown as { require?: { resolve(id: string): string } }).require;
    expect(typeof req).toBe("function");
    expect(req!.resolve("fs")).toBe("fs");
  });

  it("TrzszFilter 无 choose 回调时抛 node 模式必需错误（证明非浏览器模式）", () => {
    expect(() => new TrzszFilter({ writeToTerminal: () => {}, sendToServer: () => {} })).toThrow(
      /chooseSendFiles is required/,
    );
  });
});

describe("magicHoldLength（魔串跨块留验）", () => {
  const magic = "::TRZSZ:TRANSFER:";
  it("放行：banner 完整落在缓冲内（\\r 控制字节截断候选）", () => {
    expect(magicHoldLength(encoder.encode(`abc${magic}R:1.2.0\r\n`))).toBe(0);
    expect(magicHoldLength(encoder.encode(`${magic}S:1.2.0\r\n`))).toBe(0);
  });
  it("留验：banner 载荷被截断（版本/id 中途劈开、顶到缓冲尾）", () => {
    const banner = `${magic}S:1.2.0:17000000000100\r\n`;
    const cut = magic.length + 5; // 劈在版本串里
    expect(magicHoldLength(encoder.encode(banner.slice(0, cut)))).toBe(cut - banner.indexOf(magic));
    const cut2 = banner.length - 3; // 劈在 id 尾
    expect(magicHoldLength(encoder.encode(banner.slice(0, cut2)))).toBe(cut2 - banner.indexOf(magic));
  });
  it("留验：魔串真前缀后缀（前 17 字节内劈开）", () => {
    expect(magicHoldLength(encoder.encode("hello::TRZ"))).toBe(5);
    expect(partialMagicSuffixLength(encoder.encode(":"))).toBe(1);
  });
  it("无相关尾 → 0；超窗垃圾与不可延展尾放行", () => {
    expect(magicHoldLength(encoder.encode("plain output\r\n"))).toBe(0);
    expect(magicHoldLength(new Uint8Array(0))).toBe(0);
    // id 截断处跟了非数字可打印字符且顶到缓冲尾 → 完整且不可延展 → 放行
    expect(magicHoldLength(encoder.encode(`${magic}D:1.2.0:1700abc`))).toBe(0);
    // 超窗不成形 → 放弃（64 = MAGIC_TAIL_WINDOW）
    const long = `${magic}${"9".repeat(64)}`;
    expect(magicHoldLength(encoder.encode(long))).toBe(0);
  });
});

describe("TrzszController 数据面", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ottr-trzsz-ctrl-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("空闲态透传：输出直达终端、击键直达服务器", () => {
    const opts = makeOpts();
    const ctrl = createTrzszController(opts);
    ctrl.processServerOutput(encoder.encode("hello world\r\n"));
    expect(opts.__written.map((w) => decoder.decode(w as Uint8Array)).join("")).toBe("hello world\r\n");
    ctrl.processTerminalInput("ls\r");
    expect(sentText(opts.__sent)).toBe("ls\r");
    ctrl.dispose();
  });

  it("魔串跨块：部分后缀留验不透传，补齐后整体透传且激活下载对答", async () => {
    const chooseSaveDirectory = vi.fn(async () => undefined);
    const opts = makeOpts({ chooseSaveDirectory });
    const ctrl = createTrzszController(opts);
    const magic = "::TRZSZ:TRANSFER:S:1.2.0:17000000000100";
    const cut = magic.length - 4;
    ctrl.processServerOutput(encoder.encode("before " + magic.slice(0, cut)));
    const written = opts.__written.map((w) => decoder.decode(w as Uint8Array)).join("");
    expect(written).toBe("before "); // "::TRA" 被留验扣住
    ctrl.processServerOutput(encoder.encode(magic.slice(cut) + " after\r\n"));
    // 魔串整串已交给 filter（透传显示），10ms 内异步检测 → 下载对答
    await waitFor(() => chooseSaveDirectory.mock.calls.length > 0);
    // 拒绝（undefined）→ sendAction(false) → 传输收尾
    await waitFor(() => !ctrl.isTransferring());
    ctrl.dispose();
  });

  it("传输收尾翻转触发 onTransfersSettled（白名单撤销挂钩）", async () => {
    // 挂起对答保持传输态（undefined 立即拒绝会在断言前就收尾）
    let releaseSaveDir: ((v: string) => void) | null = null;
    const chooseSaveDirectory = vi.fn(
      () => new Promise<string | undefined>((resolve) => (releaseSaveDir = resolve)),
    );
    const settled = vi.fn();
    const opts = makeOpts({ chooseSaveDirectory, onTransfersSettled: settled });
    const ctrl = createTrzszController(opts);
    ctrl.processServerOutput(encoder.encode("::TRZSZ:TRANSFER:S:1.2.0:17000000000300\r\n"));
    await waitFor(() => chooseSaveDirectory.mock.calls.length > 0);
    expect(ctrl.isTransferring()).toBe(true);
    // 传输期间不触发
    ctrl.processServerOutput(encoder.encode("#CFG:x\r\n"));
    expect(settled).not.toHaveBeenCalled();
    // 释放对答 → 收尾；下一批 PTY 输出观测到「传输中 → 空闲」翻转 → 触发
    (releaseSaveDir as ((v: string) => void) | null)?.("/tmp/ottr-settled-unused");
    await waitFor(() => !ctrl.isTransferring());
    ctrl.processServerOutput(encoder.encode("prompt$ "));
    await waitFor(() => settled.mock.calls.length > 0);
    ctrl.dispose();
  });

  it("传输态 Ctrl-C 中止（拒绝目录 → 不发 ACT，错误回传后收尾）", async () => {
    let releaseSaveDir: ((v: string | undefined) => void) | null = null;
    const chooseSaveDirectory = vi.fn(
      () => new Promise<string | undefined>((resolve) => (releaseSaveDir = resolve)),
    );
    const opts = makeOpts({ chooseSaveDirectory });
    const ctrl = createTrzszController(opts);
    // 真实 banner 以 \r\n 收尾（无 \r\n 时以数字结尾的 id 顶到缓冲尾 → 留验等续）
    ctrl.processServerOutput(encoder.encode("::TRZSZ:TRANSFER:S:1.2.0:17000000000200\r\n"));
    await waitFor(() => chooseSaveDirectory.mock.calls.length > 0);
    expect(ctrl.isTransferring()).toBe(true);
    // 挂起的对答期间键入被吞（传输态）；Ctrl-C 触发 stopTransferring
    ctrl.processTerminalInput("x");
    ctrl.processTerminalInput("\x03");
    (releaseSaveDir as ((v: string) => void) | null)?.("/tmp/never-used-ottr"); // 闭包内赋值，TS 收窄不到
    // 目录不可写 → clientError（#fail 文本回传）→ 收尾；绝无 #ACT（未接受传输）
    await waitFor(() => sentText(opts.__sent).length > 0, 4000);
    expect(sentText(opts.__sent)).not.toContain("#ACT");
    await waitFor(() => !ctrl.isTransferring(), 4000);
    ctrl.dispose();
  });

  it("uploadFiles：校验可读 → 发 Ctrl-C + trz 启动串；坏路径 onError", async () => {
    const good = makeOpts();
    const ctrl = createTrzszController(good);
    const file = join(dir, "up.txt");
    await writeFile(file, "payload");
    void ctrl.uploadFiles([file]);
    // checkPathsReadable（真 fs）→ Ctrl-C → 200ms → "trz\r"
    await waitFor(() => sentText(good.__sent).includes("trz\r"), 3000);
    expect(sentText(good.__sent)).toContain("\x03");
    ctrl.dispose();

    const bad = makeOpts();
    const ctrl2 = createTrzszController(bad);
    const errors: string[] = [];
    const ctrl3 = createTrzszController({ ...bad, onError: (m) => errors.push(m) });
    await ctrl2.uploadFiles([join(dir, "nonexistent.bin")]);
    void ctrl3.uploadFiles([join(dir, "nonexistent.bin")]);
    await waitFor(() => errors.length > 0);
    expect(sentText(bad.__sent)).not.toContain("trz"); // 校验失败不会启动远端命令
    ctrl2.dispose();
    ctrl3.dispose();
  });

  it("dispose 后出口断流", () => {
    const opts = makeOpts();
    const ctrl = createTrzszController(opts);
    ctrl.dispose();
    ctrl.processServerOutput(encoder.encode("after dispose"));
    ctrl.processTerminalInput("q");
    expect(opts.__written.length).toBe(0);
    expect(opts.__sent.length).toBe(0);
  });
});
