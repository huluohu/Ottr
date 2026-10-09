// 同步引擎纯函数单测（Phase 5 Task 3）：
//   * 三态判定表驱动——仅本机变→push / 仅远端变→pull / 双变→conflict /
//     无变→synced，加首次同步（无快照）与远端消失两个边界簇；
//   * canonicalJson 键序不敏感（Rust serde_json 与 JS 键序不同不误报指纹）；
//   * 冲突列表逐分类生成（只含有分歧的分类；范围裁剪）；
//   * 范围勾选过滤（未勾选类清空、不丢其余类）；
//   * 指纹口径：内容相同 → 指纹相同；内容变 → 指纹变。
import { describe, expect, it } from "vitest";
import {
  SYNC_CATEGORIES,
  asSyncData,
  buildConflictList,
  canonicalEntries,
  canonicalJson,
  categoryFingerprint,
  filterSnapshot,
  fingerprint,
  isEmptySnapshot,
  judgeThreeState,
  sha256Hex,
  type SyncCategory,
  type SyncData,
  type SyncStateSnapshot,
} from "./engine";

const FP_LOCAL = "a".repeat(64);
const FP_REMOTE = "b".repeat(64);

function emptyData(): SyncData {
  const categories = {} as Record<SyncCategory, unknown[]>;
  for (const cat of SYNC_CATEGORIES) categories[cat] = [];
  return { version: 1, categories };
}

function dataWith(cat: SyncCategory, rows: unknown[]): SyncData {
  const data = emptyData();
  data.categories[cat] = rows;
  return data;
}

const snapshot = (local = FP_LOCAL, remote = FP_REMOTE): SyncStateSnapshot => ({
  local_fp: local,
  remote_fp: remote,
});

describe("三态判定（表驱动）", () => {
  const base = { localFp: FP_LOCAL, localEmpty: false };
  const cases: { name: string; input: Parameters<typeof judgeThreeState>[0]; want: string }[] = [
    // —— 有基线：核心三态 + 无变
    { name: "仅本机变 → push", input: { localFp: "d".repeat(64), localEmpty: false, remoteFp: FP_REMOTE, snapshot: snapshot() }, want: "push" },
    { name: "仅远端变 → pull", input: { localFp: FP_LOCAL, localEmpty: false, remoteFp: "c".repeat(64), snapshot: snapshot() }, want: "pull" },
    { name: "双变 → conflict", input: { localFp: "d".repeat(64), localEmpty: false, remoteFp: "c".repeat(64), snapshot: snapshot() }, want: "conflict" },
    { name: "双未变 → synced", input: { ...base, remoteFp: FP_REMOTE, snapshot: snapshot() }, want: "synced" },
    { name: "本机回到基线值而远端变 → pull", input: { ...base, remoteFp: "c".repeat(64), snapshot: snapshot() }, want: "pull" },
    // —— 无基线（首次同步）
    { name: "无快照+远端空 → push（初始）", input: { ...base, remoteFp: null, snapshot: null }, want: "push" },
    { name: "无快照+远端有+本机空 → pull（新机采纳）", input: { localFp: FP_LOCAL, localEmpty: true, remoteFp: FP_REMOTE, snapshot: null }, want: "pull" },
    { name: "无快照+远端有+本机非空 → conflict（保守）", input: { ...base, remoteFp: FP_REMOTE, snapshot: null }, want: "conflict" },
    // —— 有基线而远端消失（信封被删/换通道）
    { name: "远端消失+本机未变 → push（重建远端）", input: { ...base, remoteFp: null, snapshot: snapshot() }, want: "push" },
    { name: "远端消失+本机已变 → push（覆盖空无丢失面）", input: { localFp: "d".repeat(64), localEmpty: false, remoteFp: null, snapshot: snapshot() }, want: "push" },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(judgeThreeState(c.input)).toBe(c.want);
    });
  }
});

describe("canonicalJson 与指纹", () => {
  it("对象键序不敏感、数组保序", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe(canonicalJson({ a: [2, 1], b: 1 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ nested: { z: null, y: undefined } })).toBe('{"nested":{"y":null,"z":null}}');
  });

  it("sha256Hex 与 fingerprint 口径一致；内容变 → 指纹变", async () => {
    const text = canonicalJson({ x: 1 });
    expect(await fingerprint({ x: 1 })).toBe(await sha256Hex(text));
    expect(await fingerprint({ x: 1 })).not.toBe(await fingerprint({ x: 2 }));
    // 键序不同内容相同 → 同指纹（跨语言序列化不误报）
    expect(await fingerprint({ a: 1, b: 2 })).toBe(await fingerprint({ b: 2, a: 1 }));
  });
});

describe("范围勾选过滤", () => {
  it("未勾选类清空、勾选类保留、其余类字段不丢", () => {
    const data = dataWith("hosts", [{ id: 1 }]);
    data.categories.settings = [{ key: "ui.theme", value: "dark" }];
    const filtered = filterSnapshot(data, ["hosts"]);
    expect(filtered.categories.hosts).toHaveLength(1);
    expect(filtered.categories.settings).toHaveLength(0);
    expect(Object.keys(filtered.categories)).toHaveLength(SYNC_CATEGORIES.length);
    // 原对象不被就地修改
    expect(data.categories.settings).toHaveLength(1);
  });
});

describe("asSyncData / isEmptySnapshot", () => {
  it("结构校验：缺分类/版本错显式抛错；空库判定", () => {
    expect(asSyncData(emptyData())).toEqual(emptyData());
    expect(() => asSyncData({ version: 2, categories: {} })).toThrow(/version/);
    const missing = emptyData();
    delete (missing.categories as Partial<Record<SyncCategory, unknown[]>>).hosts;
    expect(() => asSyncData(missing)).toThrow(/hosts/);
    expect(isEmptySnapshot(emptyData())).toBe(true);
    expect(isEmptySnapshot(dataWith("hosts", [1]))).toBe(false);
  });
});

describe("双改冲突列表（逐分类生成）", () => {
  it("只含有分歧的分类，条数与指纹逐类正确；一致分类不进列表", async () => {
    const local = dataWith("hosts", [{ id: 1, name: "a" }]);
    local.categories.credentials = [{ id: 9, secret: "s" }];
    const remote = dataWith("hosts", [{ id: 1, name: "CHANGED" }]);
    remote.categories.cron_jobs = [{ id: 5 }];

    const conflicts = await buildConflictList(local, remote);
    // hosts（内容不同）、credentials（远端空）、cron_jobs（本机空）分歧；其余一致
    expect(conflicts.map((c) => c.category)).toEqual(["credentials", "hosts", "cron_jobs"]);
    const hosts = conflicts.find((c) => c.category === "hosts")!;
    expect(hosts.local_count).toBe(1);
    expect(hosts.remote_count).toBe(1);
    expect(hosts.local_fp).toBe(await categoryFingerprint(local, "hosts"));
    expect(hosts.remote_fp).toBe(await categoryFingerprint(remote, "hosts"));
    expect(hosts.local_fp).not.toBe(hosts.remote_fp);
  });

  it("内容一致（含键序差异）不误报；范围裁剪生效", async () => {
    const local = dataWith("hosts", [{ name: "a", id: 1 }]);
    const remote = dataWith("hosts", [{ id: 1, name: "a" }]); // 键序不同内容同
    expect(await buildConflictList(local, remote)).toEqual([]);
    // 两类都有分歧，但范围只勾 settings → 只列 settings
    const local2 = dataWith("hosts", [{ id: 2 }]);
    local2.categories.settings = [{ key: "k", value: 1 }];
    const remote2 = dataWith("hosts", [{ id: 3 }]);
    remote2.categories.settings = [{ key: "k", value: 2 }];
    const conflicts = await buildConflictList(local2, remote2, ["settings"]);
    expect(conflicts.map((c) => c.category)).toEqual(["settings"]);
  });

  it("行序差异不误报（canonical 投影排序）", async () => {
    const local = dataWith("hosts", [{ id: 1, name: "a" }, { id: 2, name: "b" }]);
    const remote = dataWith("hosts", [{ id: 9, name: "b" }, { id: 8, name: "a" }]);
    expect(await buildConflictList(local, remote)).toEqual([]);
  });

  // 【I-2 回归（fix round 1）】真实跨机形态：两侧同源、id 各机本地、引用字段
  // 已按各自本地图重写——未改动分类不得因 id 不同而误报。
  it("id 重映射 + 引用重写不误报；改一处只列该分类", async () => {
    const sideA = (): Partial<Record<SyncCategory, unknown[]>> => ({
      host_groups: [{ id: 1, name: "prod", parent_id: null, color: "#fff", created_at: 1, updated_at: 1 }],
      credentials: [{ id: 2, kind: "password", secret: "pw", key_pub: null, passphrase: null, totp_secret: null, created_at: 1, updated_at: 1 }],
      hosts: [{
        id: 3, name: "alpha", address: "10.0.0.1", port: 22, username: "deploy",
        group_id: 1, credential_id: 2, tags: ["web"], protocol: "ssh",
        encoding_override: null, theme_override: null, monitor_enabled: false,
        is_production: true, notes: null, created_at: 1, updated_at: 1,
      }],
      settings: [{ key: "ui.theme", value: "dark" }],
    });
    // B 机：pull 后 id 全部重映射、引用按 B 本地图重写（跨机真实形态）
    const sideB = (): Partial<Record<SyncCategory, unknown[]>> => ({
      host_groups: [{ id: 101, name: "prod", parent_id: null, color: "#fff", created_at: 1, updated_at: 1 }],
      credentials: [{ id: 202, kind: "password", secret: "pw", key_pub: null, passphrase: null, totp_secret: null, created_at: 1, updated_at: 1 }],
      hosts: [{
        id: 303, name: "alpha", address: "10.0.0.1", port: 22, username: "deploy",
        group_id: 101, credential_id: 202, tags: ["web"], protocol: "ssh",
        encoding_override: null, theme_override: null, monitor_enabled: false,
        is_production: true, notes: null, created_at: 1, updated_at: 1,
      }],
      settings: [{ key: "ui.theme", value: "dark" }],
    });
    const a = emptyData();
    a.categories = { ...a.categories, ...sideA() } as SyncData["categories"];
    const b = emptyData();
    b.categories = { ...b.categories, ...sideB() } as SyncData["categories"];

    // 同源异 id：全部分类零误报（修复前 = 全部有数据的分类都进冲突列表）
    expect(await buildConflictList(a, b)).toEqual([]);

    // 引用变化也按自然键传导（group 换名 → hosts 投影随之变化）
    const c = emptyData();
    c.categories = { ...c.categories, ...sideB() } as SyncData["categories"];
    (c.categories.host_groups[0] as Record<string, unknown>).name = "renamed";
    expect((await buildConflictList(a, c)).map((x) => x.category).sort()).toEqual([
      "host_groups",
      "hosts",
    ]);

    // 单边真改动：只列被改分类
    (b.categories.hosts[0] as Record<string, unknown>).notes = "edited on B";
    expect((await buildConflictList(a, b)).map((x) => x.category)).toEqual(["hosts"]);
  });

  it("canonicalEntries：剥除 id 与本地引用 id（投影内只留自然键/内容）", () => {
    const data = dataWith("hosts", [{ id: 7, name: "a", address: "x", port: 1 }]);
    data.categories.host_groups = [{ id: 8, name: "g", parent_id: null, color: null }];
    const projected = canonicalEntries("hosts", data)[0]!;
    expect(projected).not.toContain('"id"');
    // group 引用解析为父链全路径（BL-527 加宽；id 无关）
    const host = data.categories.hosts[0] as Record<string, unknown>;
    host.group_id = 8;
    expect(canonicalEntries("hosts", data)[0]!).toContain('"group":["g"]');
  });
});

// --- BL-527：自然键加宽（父链路径 / host·channel 区分字段）---------------------
// 冷僻构造回归：同侧自然键重复 + 引用指向重复项分歧——加宽前引用投影无法区分
// 指向哪一个重复项（漏报），加宽后照常进冲突列表。行 helper 字段以
// canonicalEntries 实际读取面为准（多余字段不进投影，无碍）。

function groupRow(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 0, name: "g", parent_id: null, color: null, created_at: 1, updated_at: 1, ...over };
}
function hostRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 0, name: "web-01", address: "10.0.0.1", port: 22, username: null, tags: [],
    protocol: "ssh", group_id: null, credential_id: null, encoding_override: null,
    theme_override: null, monitor_enabled: false, is_production: false, notes: null,
    created_at: 1, updated_at: 1, ...over,
  };
}
function ruleRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 0, host_id: 1, kind: "disk", params: {}, channels: [], rate_limit: 60,
    mute_window: null, created_at: 1, updated_at: 1, ...over,
  };
}
function chanRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 0, kind: "webhook", config: {}, template_overrides: null, enabled: true,
    created_at: 1, updated_at: 1, ...over,
  };
}

describe("BL-527 自然键加宽：同侧自然键重复 + 引用指向分歧不再漏报", () => {
  it("同名兄弟组（跨枝同名合法态）：主机分组指向分歧被识别", async () => {
    // 两侧分组树同构（p/q 下各一个 web——0018 只禁同级同名），host_groups
    // 多重集两侧一致；唯一分歧 = 主机 group 指向（p/web vs q/web）。
    const tree = (): Record<string, unknown>[] => [
      groupRow({ id: 1, name: "p" }),
      groupRow({ id: 2, name: "q" }),
      groupRow({ id: 3, name: "web", parent_id: 1 }),
      groupRow({ id: 4, name: "web", parent_id: 2 }),
    ];
    const a = emptyData();
    a.categories.host_groups = tree();
    a.categories.hosts = [hostRow({ id: 10, group_id: 3 })];
    const b = emptyData();
    b.categories.host_groups = tree();
    b.categories.hosts = [hostRow({ id: 20, group_id: 4 })];
    expect((await buildConflictList(a, b)).map((c) => c.category)).toEqual(["hosts"]);
  });

  it("同名父组跨枝（组自身投影父链消歧）：颜色换位被识别", async () => {
    // r、s 下各一个同名 p，p 下各一个 a——加宽前 a 的投影 parent 只有一级父名
    // （两个 "p" 同名不可辨），颜色换位后两侧多重集同形 → 漏报；父链路径后
    // r/p 与 s/p 可辨。
    const mk = (swap: boolean): Record<string, unknown>[] => [
      groupRow({ id: 1, name: "r" }),
      groupRow({ id: 2, name: "s" }),
      groupRow({ id: 3, name: "p", parent_id: 1 }),
      groupRow({ id: 4, name: "p", parent_id: 2 }),
      groupRow({ id: 5, name: "a", parent_id: 3, color: swap ? "#00f" : "#f00" }),
      groupRow({ id: 6, name: "a", parent_id: 4, color: swap ? "#f00" : "#00f" }),
    ];
    const a = emptyData();
    a.categories.host_groups = mk(false);
    const b = emptyData();
    b.categories.host_groups = mk(true);
    expect((await buildConflictList(a, b)).map((c) => c.category)).toEqual(["host_groups"]);
  });

  it("同端点双主机（hosts 无端点唯一约束）：规则指向分歧被识别", async () => {
    // 两侧 hosts 多重集一致（同 name+address+port、协议 ssh/sftp 各一行）；
    // alert rule 指向换位 → 加宽前 hostKeyOf 分不出协议 → 漏报。
    const hosts = (): Record<string, unknown>[] => [
      hostRow({ id: 1, name: "web-01", address: "10.0.0.1", port: 22, protocol: "ssh" }),
      hostRow({ id: 2, name: "web-01", address: "10.0.0.1", port: 22, protocol: "sftp" }),
    ];
    const a = emptyData();
    a.categories.hosts = hosts();
    a.categories.alert_rules = [ruleRow({ id: 5, host_id: 1 })];
    const b = emptyData();
    b.categories.hosts = hosts();
    b.categories.alert_rules = [ruleRow({ id: 5, host_id: 2 })];
    expect((await buildConflictList(a, b)).map((c) => c.category)).toEqual(["alert_rules"]);
  });

  it("同 kind+config 双渠道（overrides 不同）：订阅指向分歧被识别", async () => {
    const chans = (): Record<string, unknown>[] => [
      chanRow({ id: 1, kind: "webhook", config: { url: "https://x" }, template_overrides: { title: "A" } }),
      chanRow({ id: 2, kind: "webhook", config: { url: "https://x" }, template_overrides: { title: "B" } }),
    ];
    const a = emptyData();
    a.categories.notify_channels = chans();
    a.categories.alert_rules = [ruleRow({ id: 5, channels: [1] })];
    const b = emptyData();
    b.categories.notify_channels = chans();
    b.categories.alert_rules = [ruleRow({ id: 5, channels: [2] })];
    expect((await buildConflictList(a, b)).map((c) => c.category)).toEqual(["alert_rules"]);
  });

  it("链断/环防线：确定性前缀路径，两侧同形不误报", async () => {
    // 父 id 指向快照外（截断快照）：路径退化为 null（引用切断同形）；两侧同
    // 构造 → 零误报。parent 环（手工构造）同理——visited 有界不悬挂。
    const a = emptyData();
    a.categories.host_groups = [
      groupRow({ id: 3, name: "web", parent_id: 99 }),
      groupRow({ id: 4, name: "cyc1", parent_id: 5 }),
      groupRow({ id: 5, name: "cyc2", parent_id: 4 }),
    ];
    const b = emptyData();
    b.categories.host_groups = [
      groupRow({ id: 30, name: "web", parent_id: 98 }),
      groupRow({ id: 40, name: "cyc1", parent_id: 50 }),
      groupRow({ id: 50, name: "cyc2", parent_id: 40 }),
    ];
    expect(await buildConflictList(a, b)).toEqual([]);
  });
});
