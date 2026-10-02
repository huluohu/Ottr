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
 * （导出全八类确定性形态；导入 = 替换所选分类 + 回执计数）。 */
class FakeVault implements SyncVaultBridge {
  data: SyncData;
  settings = new Map<string, unknown>();
  imports: { cats: SyncCategory[]; data: unknown; mode: string }[] = [];

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
    for (const cat of SYNC_CATEGORIES) {
      if (!cats.includes(cat)) continue;
      this.data.categories[cat] = incoming.categories[cat];
      applied[cat] = incoming.categories[cat].length;
    }
    return { applied, skipped: {} };
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
    expect(vault.data.categories.credentials).toEqual([
      { id: 7, kind: "password", secret: SECRET },
    ]);
    expect(result.remoteFp).toBe(await fingerprint(transport.pushed[0]!));
    const baseline = vault.settings.get(SYNC_STATE_KEY) as { remote_fp: string };
    expect(baseline.remote_fp).toBe(result.remoteFp);
  });

  it("范围外分类不被导入（restore 范围独立于 push）", async () => {
    const remoteVault = new FakeVault({ hosts: [{ id: 1 }], settings: [{ key: "k", value: 1 }] });
    await createSyncStore({ bridge: remoteVault, transport }).push(PASSPHRASE, ALL);

    vault.data.categories.settings = [{ key: "local", value: 1 }];
    await makeStore().pull(PASSPHRASE, ["hosts"]);
    expect(vault.data.categories.hosts).toEqual([{ id: 1 }]);
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
