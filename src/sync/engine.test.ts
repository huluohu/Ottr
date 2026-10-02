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
  canonicalJson,
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
    expect(hosts.local_fp).toBe(await fingerprint(local.categories.hosts));
    expect(hosts.remote_fp).toBe(await fingerprint(remote.categories.hosts));
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
});
