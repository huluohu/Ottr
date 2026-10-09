// 双设备端到端（Phase 5 Task 5）：**两台真 vault**（Rust 桥夹具 spawn，两个独立
// 数据目录 + 各自独立 Master Key）+ 真信封加密 + 真 dufs WebDAV 通道 + 真
// SyncStore 编排（三态判定/冲突列表/裁定应用）——UI 层以下全链的整合验证。
//
// 「设备」构成：
//   * Rust 侧 = `desktop/examples/sync_bridge_fixture.rs`（stdio JSON 线协议，
//     直调与 Tauri 命令体同款的 ottr-vault 函数：sync_export/import_categories、
//     settings_get/set + validate_known_setting）——两个实例 = 两台设备；
//   * TS 侧 = 生产代码原样（createSyncStore + createWebdavTransport + engine），
//     零假件（SyncStore.test.ts 的 FakeVault 在此换成真 Rust vault）。
//
// 场景（简报钉死时间线，逐阶段断言）：
//   A 建主机推送 → B（另一数据目录+同信封口令）拉取可见（id 已重映射）→
//   B 改同条推送 → A 拉取 → A 改同条推送 → B 本机也改后拉取遇双变 →
//   conflict 列表（裁定信息面先于裁定——红线时序）→ 裁定「保留云端」应用
//   （T4 语义：云端侧 pull + 双侧并集 push）→ 两机收敛一致（自然键投影相等）。
//
// 夹具不可达即 fail-loud 并提示启动命令（webdav.dufs.test.ts 同纪律）。
// Run: 先 `scripts/spike-dufs.sh`（dufs 容器）；Rust 桥由 beforeAll 自动
// `cargo build -p ottr --example sync_bridge_fixture`（PATH 需含 ~/.cargo/bin）。
// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asSyncData, canonicalEntries, SYNC_CATEGORIES, type SyncCategory, type SyncData } from "./engine";
import { createSyncStore, type SyncImportReport, type SyncVaultBridge } from "./SyncStore";
import { createWebdavTransport } from "./webdav";

const HOST = "http://127.0.0.1:15773";
const USER = "user";
const PASS_DAV = "pass";
// 生产默认 fetchImpl = Rust 代理（webview 专用，T4/BL-524）——本文件 TS 侧
// 「生产代码原样」在 webview 网络面上有一个显式例外：vitest node 无 Tauri
// IPC，注入 node fetch 保持真 HTTP 直连（代理包装自身面在 webdav.proxy.test.ts）。
const nodeFetch: typeof fetch = (...args) => fetch(...args);
/** 信封口令（双设备共享；与 vault 主密钥无关——双层加密语义）。 */
const PASS_ENV = "p5t5-e2e-envelope-pass";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(repoRoot, "target");
const bridgeBin = path.join(targetDir, "debug", "examples", "sync_bridge_fixture");
/** 测试纪律环境（PATH=/usr/bin+~/.cargo/bin 前置——/usr/local/bin rustc 是 x86_64 残留）。 */
const cargoEnv = {
  ...process.env,
  PATH: `/usr/bin:${process.env.HOME ?? ""}/.cargo/bin:${process.env.PATH ?? ""}`,
};

let workRoot: string;
let deviceA: BridgeDevice;
let deviceB: BridgeDevice;

/** 一台「设备」：桥子进程 + 请求/响应（一问一答，行协议）。 */
class BridgeDevice implements SyncVaultBridge {
  private readonly proc: ChildProcess;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(dataDir: string) {
    this.proc = spawn(bridgeBin, [dataDir], { stdio: ["pipe", "pipe", "inherit"] });
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      const msg = JSON.parse(line) as { id: number | null; ok: boolean; result?: unknown; error?: string };
      const id = msg.id;
      if (id === null) return; // 非法帧（无 id）：丢弃
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(`bridge: ${msg.error}`));
    });
    this.proc.on("exit", (code, signal) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error(`bridge exited (code=${code} signal=${signal})`));
      }
      this.pending.clear();
    });
    this.proc.on("error", (err) => {
      for (const waiter of this.pending.values()) {
        waiter.reject(new Error(`bridge spawn error: ${err.message}`));
      }
      this.pending.clear();
    });
  }

  request<T>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc.stdin!.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
        if (err) reject(new Error(`bridge stdin write: ${err.message}`));
      });
    });
  }

  hostCreate(params: { name: string; address: string; port: number; group?: string; username?: string }) {
    return this.request<HostRow>("host_create", params);
  }

  hostUpdate(params: { name: string; port?: number; notes?: string }) {
    return this.request<HostRow>("host_update", params);
  }

  hostList() {
    return this.request<HostRow[]>("host_list");
  }

  // --- SyncVaultBridge（生产同款命令面）---------------------------------------

  async exportCategories(cats: SyncCategory[]): Promise<SyncData> {
    return asSyncData(await this.request<unknown>("export_categories", { cats }));
  }

  importCategories(cats: SyncCategory[], data: unknown, mode: "replace"): Promise<SyncImportReport> {
    return this.request<SyncImportReport>("import_categories", { cats, data, mode });
  }

  async settingsGet<T>(key: string): Promise<T | null> {
    return (await this.request<T | null>("settings_get", { key })) ?? null;
  }

  async settingsSet(key: string, value: unknown): Promise<void> {
    await this.request<null>("settings_set", { key, value });
  }

  kill() {
    this.proc.kill("SIGTERM");
  }
}

interface HostRow {
  id: number;
  name: string;
  address: string;
  port: number;
  username: string | null;
  notes: string | null;
  group_id: number | null;
}

async function dufsUp(): Promise<void> {
  try {
    const res = await fetch(`${HOST}/`);
    if (res.status < 500) return;
  } catch {
    /* unreachable → 报错 */
  }
  throw new Error(`dufs fixture unreachable at ${HOST} —— 先跑 scripts/spike-dufs.sh`);
}

beforeAll(async () => {
  await dufsUp();
  // Rust 桥即编即用（增量；lib 已被开发/测试构建缓存，通常仅编译 example 本体）
  const build = spawnSync("cargo", ["build", "-q", "-p", "ottr", "--example", "sync_bridge_fixture"], {
    cwd: repoRoot,
    env: cargoEnv,
    encoding: "utf8",
    timeout: 240_000,
  });
  if (build.error ?? build.status !== 0) {
    throw new Error(
      `cargo build --example sync_bridge_fixture failed（PATH 需含 ~/.cargo/bin）: ${
        build.error?.message ?? build.stderr
      }`,
    );
  }
  workRoot = mkdtempSync(path.join(tmpdir(), "ottr-p5t5-e2e-"));
  deviceA = new BridgeDevice(path.join(workRoot, "device-a"));
  deviceB = new BridgeDevice(path.join(workRoot, "device-b"));
  // 就绪探针（启动失败 exit 1 → 请求 reject fail-loud）
  await deviceA.request("ping");
  await deviceB.request("ping");
}, 300_000);

afterAll(() => {
  deviceA?.kill();
  deviceB?.kill();
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

describe("双设备端到端（真 vault 双数据目录 + 真信封 + dufs + SyncStore）", () => {
  it("A 建→推→B 拉→B 改→推→A 拉→A 改→推→B 双变→conflict→保留云端→收敛一致", async () => {
    const remotePath = `ottr-sync-e2e-${Date.now()}-${Math.floor(Math.random() * 1e9)}.json`;
    const transportA = createWebdavTransport({ server: HOST, remotePath, username: USER, password: PASS_DAV }, { fetchImpl: nodeFetch });
    const transportB = createWebdavTransport({ server: HOST, remotePath, username: USER, password: PASS_DAV }, { fetchImpl: nodeFetch });
    const storeA = createSyncStore({ bridge: deviceA, transport: transportA });
    const storeB = createSyncStore({ bridge: deviceB, transport: transportB });

    // ── 阶段 1：A 建主机 → 首推（无基线 + 远端无信封 → push）──────────────
    const hostA = await deviceA.hostCreate({ name: "web-01", address: "10.0.0.1", port: 22, group: "prod", username: "deploy" });
    const s1 = await storeA.status();
    expect(s1.action).toBe("push"); // 无基线 + 远端无信封 → 初始推送
    expect(s1.remoteExists).toBe(false);
    expect(s1.baseline).toBeNull();
    const push1 = await storeA.push(PASS_ENV);
    expect(push1.action).toBe("push");
    expect(push1.remoteFp).toMatch(/^[0-9a-f]{64}$/);

    // ── 阶段 2：B（独立数据目录+同口令）拉取可见 ─────────────────────────
    const s2 = await storeB.status(PASS_ENV);
    expect(s2.action).toBe("pull"); // 新机空库 + 远端有信封 → 采纳远端
    const pull2 = await storeB.pull(PASS_ENV);
    // Rust SyncImportReport.applied = 全部所选分类的精确落库计数（含 0）
    expect(pull2.report.applied).toEqual({
      alert_rules: 0, credentials: 0, cron_jobs: 0,
      host_groups: 1, hosts: 1,
      notify_channels: 0, settings: 0, snippets: 0,
    });
    // skipped 只含可能有整行跳过路径的分类（host_id NOT NULL 的规则/任务、
    // 被拒 settings 键）——全 0 = 零跳过
    expect(pull2.report.skipped).toEqual({ alert_rules: 0, cron_jobs: 0, settings: 0 });
    const hostsB = await deviceB.hostList();
    expect(hostsB).toHaveLength(1);
    expect(hostsB[0]).toMatchObject({ name: "web-01", address: "10.0.0.1", port: 22, username: "deploy" });
    expect(hostsB[0].group_id).not.toBeNull(); // 引用随组重映射保留（B 本地新 id）

    // ── 阶段 3：B 改同条 → 推送（仅本机变 → push）────────────────────────
    await deviceB.hostUpdate({ name: "web-01", port: 2222 });
    expect((await storeB.status()).action).toBe("push");
    await storeB.push(PASS_ENV);

    // ── 阶段 4：A 拉取（仅远端变 → pull），拿到 B 的修改 ──────────────────
    expect((await storeA.status(PASS_ENV)).action).toBe("pull");
    const pull4 = await storeA.pull(PASS_ENV);
    expect(pull4.report.applied).toMatchObject({ host_groups: 1, hosts: 1 });
    const hostA2 = (await deviceA.hostList())[0];
    expect(hostA2.port).toBe(2222);
    expect(hostA2.id).not.toBe(hostA.id); // 全量替换导入：A 本机行也走了 id 重映射

    // ── 阶段 5：A 改同条 → 推送（云端口令不变、内容已分叉）────────────────
    await deviceA.hostUpdate({ name: "web-01", port: 2223, notes: "a-edit" });
    await storeA.push(PASS_ENV);

    // ── 阶段 6：B 本机也改同条 → status 遇双变 → conflict 列表 ─────────────
    await deviceB.hostUpdate({ name: "web-01", port: 2299, notes: "b-edit" });
    const s6 = await storeB.status(PASS_ENV);
    expect(s6.action).toBe("conflict"); // 本机变（2299）+ 远端变（A 的 v3）
    // 红线时序：裁定信息面（将被覆盖的本机值/云端值）先于任何应用动作存在
    expect(s6.conflicts).toEqual([
      {
        category: "hosts",
        local_count: 1,
        remote_count: 1,
        local_fp: expect.stringMatching(/^[0-9a-f]{64}$/),
        remote_fp: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    // 跨真机零误报（T3 I-2）：id 各机不同 + 行序无关，未改动分类不进列表
    expect(s6.conflicts?.map((c) => c.category)).toEqual(["hosts"]);

    // ── 阶段 7：裁定「保留云端」→ 应用（T4 语义：云端侧 pull + 并集 push）──
    const pull7 = await storeB.pull(PASS_ENV, ["hosts"]);
    expect(pull7.report.applied).toEqual({ hosts: 1 }); // 只替换裁定的云端侧分类
    const converged = (await deviceB.hostList())[0];
    expect(converged.port).toBe(2223); // 云端值胜
    expect(converged.notes).toBe("a-edit");
    await storeB.push(PASS_ENV); // 双侧有数据分类并集发布合并结果

    // ── 阶段 8：收敛一致 ────────────────────────────────────────────────
    expect((await storeB.status()).action).toBe("synced");
    expect((await storeA.status()).action).toBe("pull"); // 远端是 B 的合并信封（同内容异字节）
    await storeA.pull(PASS_ENV);
    expect((await storeA.status()).action).toBe("synced");
    // 内容级收敛：自然键 canonical 投影逐类相等（id 仍各机各表）
    const [dataA, dataB] = await Promise.all([
      deviceA.exportCategories([...SYNC_CATEGORIES]),
      deviceB.exportCategories([...SYNC_CATEGORIES]),
    ]);
    for (const cat of SYNC_CATEGORIES) {
      expect([...canonicalEntries(cat, dataA)].sort()).toEqual([...canonicalEntries(cat, dataB)].sort());
    }
    const finalA = (await deviceA.hostList())[0];
    expect(finalA).toMatchObject({ name: "web-01", port: 2223, notes: "a-edit" });
    expect(finalA.id).not.toBe(converged.id); // 仍是两台独立库
  }, 120_000);

  it("同数据双推：远端信封变体被判 pull、拉回同内容为收敛 no-op", async () => {
    // T3 披露的语义边界在真链上复核：两次推送同数据产出不同信封（随机
    // salt/nonce → 异指纹）→ 对端判「远端变 → pull」，导入同内容后重导出
    // 指纹不变 = no-op 收敛（last-writer 传输语义上的无害往返）。
    const remotePath = `ottr-sync-e2e-${Date.now()}-${Math.floor(Math.random() * 1e9)}.json`;
    const tA = createWebdavTransport({ server: HOST, remotePath, username: USER, password: PASS_DAV }, { fetchImpl: nodeFetch });
    const tB = createWebdavTransport({ server: HOST, remotePath, username: USER, password: PASS_DAV }, { fetchImpl: nodeFetch });
    const a = createSyncStore({ bridge: deviceA, transport: tA });
    const b = createSyncStore({ bridge: deviceB, transport: tB });

    await b.push(PASS_ENV); // B 首推（A 基线还是上一用例的旧远端 → pull 采纳）
    await a.pull(PASS_ENV);
    expect((await a.status()).action).toBe("synced");

    await b.push(PASS_ENV); // 同数据再推 → 新信封字节（异 fp）
    expect((await a.status(PASS_ENV)).action).toBe("pull");
    await a.pull(PASS_ENV);
    expect((await a.status()).action).toBe("synced");
    const hostsA = await deviceA.hostList();
    expect(hostsA).toHaveLength(1); // 内容仍是上一用例收敛后的那台主机
    expect(hostsA[0]).toMatchObject({ name: "web-01", port: 2223 });
  }, 60_000);
});
