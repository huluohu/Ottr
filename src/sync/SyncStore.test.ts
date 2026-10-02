// 同步编排单测（Phase 5 Task 3）——假 vault 桥 + 假传输 + **真信封加密**：
//   * push 全链：全八类导出 → 范围过滤入信封 → 真密封 → 传输 → 基线落 settings
//     （remote_fp = 推送信封的指纹）；
//   * pull 全链：fetch → 真开封 → 范围内全量替换导入 → 重导出 → 基线刷新；
//     远端无信封显式报错；
//   * 敏感断言（双层加密语义抽检）：信封 JSON 外层无明文凭据（含其 base64
//     形态），开封后数据完整含明文；settings 基线只存指纹不存数据；
//   * 三态联动：推/拉后 status=synced；本机变→push、远端变→pull、双变→
//     conflict（带口令给逐分类明细，不带口令 conflicts=null）；
//   * 范围勾选：偏好持久化、省缺回退全八类、非法集显式拒绝。
import { beforeEach, describe, expect, it } from "vitest";
import {
  SCOPE_PUSH_KEY,
  SYNC_STATE_KEY,
  createSyncStore,
  normalizeScope,
  type SyncImportReport,
  type SyncVaultBridge,
} from "./SyncStore";
import { openEnvelope, utf8, type SyncEnvelope } from "./envelope";
import { fingerprint, SYNC_CATEGORIES, type SyncCategory, type SyncData } from "./engine";
import type { SyncTransport } from "./transport";

const PASSPHRASE = "sync-passphrase-独立于本机主密码";
const SECRET = "SUPER-SECRET-PASSWORD-42";
const ALL: SyncCategory[] = [...SYNC_CATEGORIES];

/** 内存 vault：可变数据 + 导出/导入按 Rust sync_snapshot 的契约行为模拟
 * （导出全八类确定性形态；导入 = 替换所选分类 + 回执计数 + **id 重映射**
 * （fix round 1 I-2 测试保真度：AUTOINCREMENT 新 id ≠ 源 id，引用字段按
 * Rust 同款规则重写/切断/跳行）+ settings sync.* 键免疫）。 */
class FakeVault implements SyncVaultBridge {
  data: SyncData;
  settings = new Map<string, unknown>();
  imports: { cats: SyncCategory[]; data: unknown; mode: string }[] = [];
  private nextId = 5000; // 重映射源：与测试数据 id（1..99）显著不同，断言可辨

  constructor(data?: Partial<SyncData["categories"]>) {
    this.data = { version: 1, categories: { ...emptyCategories(), ...data } };
  }

  async exportCategories(cats: SyncCategory[]): Promise<SyncData> {
    const out = {} as Record<SyncCategory, unknown[]>;
    for (const cat of SYNC_CATEGORIES) out[cat] = cats.includes(cat) ? this.data.categories[cat] : [];
    return { version: 1, categories: out };
  }

  async importCategories(cats: SyncCategory[], raw: unknown, mode: "replace"): Promise<SyncImportReport> {
    this.imports.push({ cats: [...cats], data: raw, mode });
    const incoming = raw as SyncData;
    const applied: Record<string, number> = {};
    const skipped: Record<string, number> = {};

    // pass 1：按 canonical 序为所选分类分配新 id（AUTOINCREMENT 模拟）
    const maps = new Map<SyncCategory, Map<number, number>>();
    for (const cat of SYNC_CATEGORIES) {
      if (!cats.includes(cat)) continue;
      const map = new Map<number, number>();
      for (const row of incoming.categories[cat]) {
        this.nextId += 1;
        map.set((row as { id: number }).id, this.nextId);
      }
      maps.set(cat, map);
    }
    const remapRef = (cat: SyncCategory, id: number | null): number | null =>
      id === null || id === undefined ? null : (maps.get(cat)?.get(id) ?? null);

    // pass 2：清空后写行（全量替换；id/引用重映射；不可解析引用切断；hostless 跳行）
    for (const cat of SYNC_CATEGORIES) {
      if (!cats.includes(cat)) continue;
      this.data.categories[cat] = [];
      let appliedCount = 0;
      let skippedCount = 0;
      for (const src of incoming.categories[cat]) {
        const row = src as Record<string, unknown>;
        switch (cat) {
          case "host_groups":
            this.data.categories.host_groups.push({
              ...row,
              id: maps.get(cat)!.get(row.id as number),
              parent_id: remapRef("host_groups", row.parent_id as number | null),
            });
            appliedCount += 1;
            break;
          case "credentials":
            this.data.categories.credentials.push({
              ...row,
              id: maps.get(cat)!.get(row.id as number),
            });
            appliedCount += 1;
            break;
          case "hosts":
            this.data.categories.hosts.push({
              ...row,
              id: maps.get(cat)!.get(row.id as number),
              jump_chain_id: null, // 不在同步集，导出侧已剥离（防御性置空）
              group_id: remapRef("host_groups", row.group_id as number | null),
              credential_id: remapRef("credentials", row.credential_id as number | null),
            });
            appliedCount += 1;
            break;
          case "snippets":
            this.data.categories.snippets.push({
              ...row,
              id: maps.get(cat)!.get(row.id as number),
              host_scope: remapRef("hosts", row.host_scope as number | null),
            });
            appliedCount += 1;
            break;
          case "notify_channels":
            this.data.categories.notify_channels.push({
              ...row,
              id: maps.get(cat)!.get(row.id as number),
            });
            appliedCount += 1;
            break;
          case "alert_rules":
          case "cron_jobs": {
            const hostId = remapRef("hosts", row.host_id as number);
            if (hostId === null) {
              skippedCount += 1; // host_id NOT NULL：宿主不可重映射 → 整行跳过
              break;
            }
            const channels = (row.channels as number[]).map(
              (id) => maps.get("notify_channels")?.get(id),
            ).filter((x): x is number => x !== undefined);
            this.data.categories[cat].push({ ...row, id: maps.get(cat)!.get(row.id as number), host_id: hostId, channels });
            appliedCount += 1;
            break;
          }
          case "settings":
            // sync.* 簿记键免疫（Rust I-1 防线同款）
            if (String(row.key).startsWith("sync.")) {
              skippedCount += 1;
              break;
            }
            this.data.categories.settings.push({ ...row });
            appliedCount += 1;
            break;
        }
      }
      applied[cat] = appliedCount;
      if (skippedCount > 0) skipped[cat] = skippedCount;
    }
    return { applied, skipped };
  }

  async settingsGet<T = unknown>(key: string): Promise<T | null> {
    return (this.settings.get(key) as T) ?? null;
  }

  async settingsSet(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }
}

/** 内存传输：信封槽位 + 推送记录。 */
class FakeTransport implements SyncTransport {
  kind = "fake";
  envelope: SyncEnvelope | null = null;
  pushed: SyncEnvelope[] = [];

  async fetch(): Promise<SyncEnvelope | null> {
    return this.envelope;
  }

  async push(envelope: SyncEnvelope): Promise<void> {
    this.pushed.push(envelope);
    this.envelope = envelope;
  }

  async test(): Promise<boolean> {
    return true;
  }
}

function emptyCategories(): Record<SyncCategory, unknown[]> {
  const out = {} as Record<SyncCategory, unknown[]>;
  for (const cat of SYNC_CATEGORIES) out[cat] = [];
  return out;
}

let vault: FakeVault;
let transport: FakeTransport;

function makeStore(): ReturnType<typeof createSyncStore> {
  return createSyncStore({ bridge: vault, transport });
}

const localData = (): SyncData => ({
  version: 1,
  categories: {
    ...emptyCategories(),
    hosts: [{ id: 1, name: "alpha" }],
    credentials: [{ id: 2, kind: "password", secret: SECRET }],
    settings: [{ key: "ui.theme", value: "dark" }],
  },
});

beforeEach(() => {
  vault = new FakeVault();
  transport = new FakeTransport();
});

describe("push 全链", () => {
  it("导出→范围过滤→真密封→传输→基线（remote_fp=推送信封指纹）", async () => {
    vault.data = localData();
    const store = makeStore();
    const result = await store.push(PASSPHRASE, ["hosts", "settings"]);

    expect(transport.pushed).toHaveLength(1);
    const env = transport.pushed[0]!;
    expect(await fingerprint(env)).toBe(result.remoteFp);

    // 范围过滤生效：credentials 未入信封（对远端不可见）
    const opened = JSON.parse(utf8.decode(await openEnvelope(env, PASSPHRASE)));
    expect(opened.categories.hosts).toHaveLength(1);
    expect(opened.categories.credentials).toHaveLength(0);

    const baseline = vault.settings.get(SYNC_STATE_KEY) as { remote_fp: string; local_fp: string };
    expect(baseline.remote_fp).toBe(result.remoteFp);
    expect(baseline.local_fp).toBe(result.localFp);
    expect(result.localFp).toBe(await fingerprint(vault.data));
  });

  it("范围省缺 = push 范围偏好（settings 持久化集）", async () => {
    const store = makeStore();
    await store.setScope("push", ["hosts"]);
    await store.push(PASSPHRASE);
    const opened = JSON.parse(
      utf8.decode(await openEnvelope(transport.pushed[0]!, PASSPHRASE)),
    );
    expect(opened.categories.hosts).toHaveLength(0); // 空库，但键存在=全链走通
    expect(vault.imports).toHaveLength(0); // push 不触发导入
    expect(vault.settings.get(SCOPE_PUSH_KEY)).toEqual(["hosts"]);
  });

  it("空口令显式拒绝", async () => {
    await expect(makeStore().push("", ALL)).rejects.toThrow(/passphrase/);
  });
});

describe("pull 全链", () => {
  it("fetch→真开封→范围内替换导入→基线刷新；凭据明文 roundtrip", async () => {
    // 远端（另一台机器推的信封）：含凭据明文 + 渠道（信封落在共享传输槽位）
    const remoteVault = new FakeVault({
      credentials: [{ id: 7, kind: "password", secret: SECRET }],
      notify_channels: [{ id: 8, kind: "bark", config: { url: "https://bark.example/x" } }],
    });
    await createSyncStore({ bridge: remoteVault, transport }).push(
      PASSPHRASE,
      ["credentials", "notify_channels"],
    );

    const store = makeStore(); // 本机空库
    const result = await store.pull(PASSPHRASE, ["credentials", "notify_channels"]);
    expect(result.action).toBe("pull");
    expect(result.report.applied).toMatchObject({ credentials: 1, notify_channels: 1 });
    // id 已重映射（跨机真实形态），内容（凭据明文）完整落地
    expect(vault.data.categories.credentials).toHaveLength(1);
    expect((vault.data.categories.credentials[0] as Record<string, unknown>).secret).toBe(SECRET);
    expect((vault.data.categories.credentials[0] as Record<string, unknown>).id).not.toBe(7);
    expect(result.remoteFp).toBe(await fingerprint(transport.pushed[0]!));
    const baseline = vault.settings.get(SYNC_STATE_KEY) as { remote_fp: string };
    expect(baseline.remote_fp).toBe(result.remoteFp);
  });

  it("范围外分类不被导入（restore 范围独立于 push）", async () => {
    const remoteVault = new FakeVault({ hosts: [{ id: 1 }], settings: [{ key: "k", value: 1 }] });
    await createSyncStore({ bridge: remoteVault, transport }).push(PASSPHRASE, ALL);

    vault.data.categories.settings = [{ key: "local", value: 1 }];
    await makeStore().pull(PASSPHRASE, ["hosts"]);
    expect(vault.data.categories.hosts).toHaveLength(1);
    expect(vault.data.categories.settings).toEqual([{ key: "local", value: 1 }]); // 未被替换
  });

  it("远端无信封显式报错（pull 无从谈起）", async () => {
    await expect(makeStore().pull(PASSPHRASE, ALL)).rejects.toThrow(/no sync envelope/);
  });

  it("错口令 → 信封认证错原样上抛（不吞）", async () => {
    const remoteVault = new FakeVault({ hosts: [{ id: 1 }] });
    await createSyncStore({ bridge: remoteVault, transport }).push(PASSPHRASE, ALL);
    await expect(makeStore().pull("wrong-passphrase", ALL)).rejects.toThrow(/authentication failed/);
  });
});

describe("三态联动（真实信封在场）", () => {
  it("推/拉后 status=synced；本机变→push；远端变→pull；双变→conflict 带明细", async () => {
    const store = makeStore();
    await store.push(PASSPHRASE, ALL);
    expect((await store.status()).action).toBe("synced");

    // 仅本机变（未推送）→ push
    vault.data.categories.hosts = [{ id: 1, name: "changed-locally" }];
    expect((await store.status()).action).toBe("push");

    // 推平后模拟另一台机器改远端 → 仅远端变 → pull
    await store.push(PASSPHRASE, ALL);
    const remoteData = JSON.parse(utf8.decode(await openEnvelope(transport.envelope!, PASSPHRASE)));
    remoteData.categories.hosts = [{ id: 1, name: "changed-remotely" }];
    transport.envelope = null;
    await createSyncStore({ bridge: new FakeVault(remoteData.categories), transport }).push(
      PASSPHRASE,
      ALL,
    );
    expect((await store.status()).action).toBe("pull");

    // 本机也改 → 双变 → conflict：带口令给逐分类明细，不带口令 conflicts=null
    vault.data.categories.hosts = [{ id: 1, name: "changed-locally-again" }];
    const conflict = await store.status(PASSPHRASE);
    expect(conflict.action).toBe("conflict");
    expect(conflict.conflicts!.map((c) => c.category)).toEqual(["hosts"]);
    expect(conflict.conflicts![0]!.local_count).toBe(1);
    expect(conflict.conflicts![0]!.remote_count).toBe(1);
    const noPass = await store.status();
    expect(noPass.action).toBe("conflict");
    expect(noPass.conflicts).toBeNull();
  });

  it("首次同步：远端空→push（建基线后 synced）", async () => {
    const store = makeStore();
    const before = await store.status();
    expect(before.action).toBe("push");
    expect(before.baseline).toBeNull();
    expect(before.remoteExists).toBe(false);
    await store.push(PASSPHRASE, ALL);
    expect((await store.status()).action).toBe("synced");
  });
});

describe("I-2 回归：真实跨机场景（fix round 1）", () => {
  /** 同源四类数据（分组树 + 凭据 + 主机 + 设置），A/B 两侧各自本地 id。 */
  const originData = (sideOffset: number) => ({
    host_groups: [{ id: 1, name: "prod", parent_id: null, color: null, created_at: 1, updated_at: 1 }],
    credentials: [{ id: 2, kind: "password", secret: SECRET, key_pub: null, passphrase: null, totp_secret: null, created_at: 1, updated_at: 1 }],
    hosts: [{
      id: 3 + sideOffset, name: "alpha", address: "10.0.0.1", port: 22, username: "deploy",
      group_id: 1, credential_id: 2, tags: [], protocol: "ssh", jump_chain_id: null,
      encoding_override: null, theme_override: null, monitor_enabled: false,
      is_production: false, notes: null, created_at: 1, updated_at: 1,
    }],
    settings: [{ key: "ui.theme", value: "dark" }],
  });

  it("B 机 pull 后 id 重映射，A 再改一个分类 → 双变冲突只列被改分类（不系统性误报）", async () => {
    // A 机：同源数据 + 基线
    vault = new FakeVault(originData(0));
    transport = new FakeTransport();
    const storeA = createSyncStore({ bridge: vault, transport });
    await storeA.push(PASSPHRASE, ALL);

    // B 机：空库 pull → FakeVault 按 Rust 同款规则做 id 重映射
    const vaultB = new FakeVault();
    const storeB = createSyncStore({ bridge: vaultB, transport });
    await storeB.pull(PASSPHRASE, ALL);
    const hostB = vaultB.data.categories.hosts[0] as Record<string, unknown>;
    expect(hostB.id).not.toBe(3); // 重映射已发生（测试保真度前提）
    expect(hostB.group_id).not.toBe(1); // 引用也按 B 本地图重写

    // A 机改 hosts（且推送）；B 机改 settings —— 双变
    (vault.data.categories.hosts[0] as Record<string, unknown>).notes = "A-side edit";
    await storeA.push(PASSPHRASE, ALL);
    vaultB.data.categories.settings = [{ key: "ui.theme", value: "light" }];

    const status = await storeB.status(PASSPHRASE);
    expect(status.action).toBe("conflict");
    // 修复前：hosts/host_groups/credentials 全部因 id 不同进列表；修复后只列真分歧
    expect(status.conflicts!.map((c) => c.category).sort()).toEqual(["hosts", "settings"]);
    expect(status.conflicts!.find((c) => c.category === "hosts")!.remote_count).toBe(1);
  });
});

describe("双层加密语义敏感断言（抽检）", () => {
  it("信封外层无凭据明文（含 base64 形态）；开封后明文完整；基线只存指纹", async () => {
    vault.data = localData();
    const store = makeStore();
    await store.push(PASSPHRASE, ALL); // 范围=全八类，凭据在信封内

    const envJson = JSON.stringify(transport.pushed[0]!);
    expect(envJson).not.toContain(SECRET);
    expect(envJson).not.toContain(btoa(SECRET).slice(0, 12)); // base64 形态抽检
    expect(envJson).not.toContain("ui.theme"); // 未开封的 JSON 无任何结构泄露

    const opened = JSON.parse(utf8.decode(await openEnvelope(transport.pushed[0]!, PASSPHRASE)));
    expect(opened.categories.credentials[0].secret).toBe(SECRET); // 信封内明文完整

    for (const [key, value] of vault.settings) {
      expect(JSON.stringify(value)).not.toContain(SECRET); // 基线/范围偏好只存指纹
      expect(key).toMatch(/^sync\./);
    }
  });
});

describe("范围勾选校验", () => {
  it("normalizeScope：去重 + canonical 序；空/未知显式拒绝", () => {
    expect(normalizeScope(["settings", "hosts", "hosts"])).toEqual(["hosts", "settings"]);
    expect(() => normalizeScope([])).toThrow(/must not be empty/);
    expect(() => normalizeScope(["nonsense" as SyncCategory])).toThrow(/unknown sync category/);
  });
});
