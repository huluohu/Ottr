// 同步引擎纯函数面（Phase 5 Task 3）——三态判定 / 冲突列表 / 范围过滤 / 指纹。
//
// 与 Task 2（信封 + 三通道传输，同目录）的分工：传输层搬运信封字节，本模块
// 只做「指纹进 → 动作出」的无 IO 判定；有 IO 的编排（fetch → 判定 → push/pull、
// settings 持久化）在 SyncStore.ts，Rust 侧数据面（分类快照导出/导入 + id
// 重映射）在 ottr-vault sync_snapshot 模块。
//
// 三态判定（裁定语义，表驱动 TDD）：
//   快照（settings `sync.state`：上次推/拉后的 {remote_fp, local_fp}）对照
//   本机当前数据指纹与远端信封指纹——
//     仅本机变  → push（覆盖远端）
//     仅远端变  → pull（应用远端）
//     双变      → conflict（逐分类冲突列表，粒度裁定见 task-3-report：
//                 全量替换语义下分类是可控的最细人工处理粒度）
//   首次同步（无快照）：远端空 → push；远端有而本机空 → pull（新机adopt远端）；
//   远端有而本机非空 → conflict（保守：无基线无法自动定方向）。
//   快照在而远端消失（信封被删/换通道）→ push（覆盖「空」不存在数据丢失面）。
//
// 指纹约定：sha256(canonicalJson(x))——canonicalJson 递归排序对象键，指纹对
// 序列化键序不敏感（Rust serde_json 与 JS JSON.stringify 键序不同也不误报）。
// 远端指纹 = 信封 JSON 的指纹（不需要口令即可比对；开封只在 pull/conflict 明细时）。

/** 八类同步分类（与 Rust SYNC_CATEGORIES 逐字同构；顺序 = canonical 序）。 */
export const SYNC_CATEGORIES = [
  "host_groups",
  "credentials",
  "hosts",
  "snippets",
  "notify_channels",
  "alert_rules",
  "cron_jobs",
  "settings",
] as const;

export type SyncCategory = (typeof SYNC_CATEGORIES)[number];

/** 分类快照（Rust sync_export_categories 的返回形态）。 */
export interface SyncData {
  version: number;
  categories: Record<SyncCategory, unknown[]>;
}

/** 同步状态快照（settings `sync.state`：上次推/拉成功后的双指纹基线）。 */
export interface SyncStateSnapshot {
  remote_fp: string;
  local_fp: string;
  /** 落基线时刻（秒级 Unix；仅展示用，不参与判定）。 */
  saved_at?: number;
}

/** 三态判定动作。 */
export type SyncAction = "synced" | "push" | "pull" | "conflict";

export interface JudgeInput {
  /** 本机当前数据指纹（sha256 of 全八类导出 JSON）。 */
  localFp: string;
  /** 本机是否为空库（全八类皆空数组——首次同步方向判定用）。 */
  localEmpty: boolean;
  /** 远端信封指纹；null = 远端无信封（首次/被删）。 */
  remoteFp: string | null;
  /** 上次同步基线；null = 从未同步过。 */
  snapshot: SyncStateSnapshot | null;
}

export function judgeThreeState(input: JudgeInput): SyncAction {
  const { localFp, localEmpty, remoteFp, snapshot } = input;
  if (snapshot === null) {
    if (remoteFp === null) return "push"; // 双方皆空白：初始 push
    return localEmpty ? "pull" : "conflict"; // 新机遇远端：空则采纳，非空保守冲突
  }
  if (remoteFp === null) return "push"; // 远端消失：覆盖空无丢失面
  const localChanged = localFp !== snapshot.local_fp;
  const remoteChanged = remoteFp !== snapshot.remote_fp;
  if (localChanged && remoteChanged) return "conflict";
  if (localChanged) return "push";
  if (remoteChanged) return "pull";
  return "synced";
}

// --- 指纹 ---------------------------------------------------------------------

/** 递归键序 canonical JSON（对象键排序、数组保序、undefined 归 null）。 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** SHA-256 十六进制摘要（WebCrypto；信封同栈，node/webview 两栖）。 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 数据指纹（sha256 of canonical JSON）——本机导出与远端信封共用此口径。 */
export function fingerprint(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

// --- 快照操作 ------------------------------------------------------------------

/** 结构粗校验（分类齐全 + 数组）；Rust 导入侧再做逐条严格校验。 */
export function asSyncData(value: unknown): SyncData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sync payload is not an object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) throw new Error(`unsupported sync data version: ${String(obj.version)}`);
  const categories = obj.categories;
  if (categories === null || typeof categories !== "object" || Array.isArray(categories)) {
    throw new Error("sync payload is missing categories object");
  }
  const out = {} as Record<SyncCategory, unknown[]>;
  for (const cat of SYNC_CATEGORIES) {
    const arr = (categories as Record<string, unknown>)[cat];
    if (!Array.isArray(arr)) throw new Error(`sync payload is missing category "${cat}"`);
    out[cat] = arr;
  }
  return { version: 1, categories: out };
}

/** 范围勾选过滤（push 入信封 / 冲突明细限所选集共用；顺序按 canonical 序）。 */
export function filterSnapshot(data: SyncData, cats: readonly SyncCategory[]): SyncData {
  const out = {} as Record<SyncCategory, unknown[]>;
  for (const cat of SYNC_CATEGORIES) {
    out[cat] = cats.includes(cat) ? data.categories[cat] : [];
  }
  return { version: data.version, categories: out };
}

/** 空库判定（全八类皆空数组）。 */
export function isEmptySnapshot(data: SyncData): boolean {
  return SYNC_CATEGORIES.every((cat) => data.categories[cat].length === 0);
}

// --- 自然键 canonical 化（fix round 1 I-2：remap 不变量）-----------------------
//
// 跨机比对不能按原始数组（含各机本地 id 与重映射前的引用字段）——B 机 pull 后
// id 已重映射，未改动的分类两侧 id 也不同，会把全部有数据的分类误报进冲突列表。
// 本节把每类条目投影成 **id 无关的 canonical 形态**：
//   * 剥除本地 id；
//   * 引用字段（group_id/credential_id/host_scope/host_id/channels）解析为
//     被引用条目在**同一侧快照内**的自然键（分组名 / 主机 name+address+port /
//     凭据内容指纹 / 渠道 kind+config）——重映射只换 id 不换内容，投影不变；
//   * 条目数组按 canonical 串排序（行序差异不误报；重复自然键=多条目，multiset
//     语义保留）。
// 无法自然键匹配的差异（真新增/删除/内容改动）照常进指纹——误报消灭，真分歧
// 不漏报。注意粒度边界（披露）：仅「分组归属变化」（host.group_id 指向换了名字
// 不同的组）会同时体现在 hosts 与 host_groups 两类的投影里；被引用条目内容变化
// 会传导到引用方投影（如凭据改密 → 引用它的主机也计分歧）——全量替换语义下
// 引用方确实受牵连，宁多列不漏列。

type Row = Record<string, unknown>;

const rowsOf = (data: SyncData, cat: SyncCategory): Row[] =>
  (data.categories[cat] ?? []) as Row[];

const sortedStrings = (values: unknown): unknown[] =>
  Array.isArray(values) ? [...values].map(String).sort() : [];

const lookup = <T>(
  rows: Row[],
  id: unknown,
  key: (row: Row) => T,
): T | null => {
  if (id === null || id === undefined) return null;
  const hit = rows.find((r) => r.id === id);
  return hit === undefined ? null : key(hit);
};

/**
 * 单类条目的自然键 canonical 投影（remap 不变量；id 与本地引用 id 已剥除/
 * 解析）。设置类条目天然带业务主键（key），其余类按上表投影。
 */
export function canonicalEntries(cat: SyncCategory, data: SyncData): string[] {
  const groups = rowsOf(data, "host_groups");
  const creds = rowsOf(data, "credentials");
  const hosts = rowsOf(data, "hosts");
  const chans = rowsOf(data, "notify_channels");

  const groupKeyOf = (id: unknown): unknown =>
    lookup(groups, id, (g) => g.name);
  const hostKeyOf = (id: unknown): unknown =>
    lookup(hosts, id, (h) =>
      canonicalJson({ name: h.name, address: h.address, port: h.port }),
    );
  const credKeyOf = (id: unknown): unknown =>
    lookup(creds, id, (c) => credentialEntry(c));
  const chanKeyOf = (id: unknown): unknown =>
    lookup(chans, id, (c) => canonicalJson({ kind: c.kind, config: c.config }));

  switch (cat) {
    case "host_groups":
      return groups.map((g) =>
        canonicalJson({
          name: g.name,
          color: g.color,
          parent: groupKeyOf(g.parent_id),
          created_at: g.created_at,
          updated_at: g.updated_at,
        }),
      );
    case "credentials":
      return creds.map(credentialEntry);
    case "hosts":
      return hosts.map((h) =>
        canonicalJson({
          name: h.name,
          address: h.address,
          port: h.port,
          username: h.username,
          tags: sortedStrings(h.tags),
          protocol: h.protocol,
          group: groupKeyOf(h.group_id),
          credential: credKeyOf(h.credential_id),
          encoding_override: h.encoding_override,
          theme_override: h.theme_override,
          monitor_enabled: h.monitor_enabled,
          is_production: h.is_production,
          notes: h.notes,
          created_at: h.created_at,
          updated_at: h.updated_at,
        }),
      );
    case "snippets":
      return rowsOf(data, "snippets").map((s) =>
        canonicalJson({
          name: s.name,
          body: s.body,
          variables: sortedStrings(s.variables),
          tags: sortedStrings(s.tags),
          host: hostKeyOf(s.host_scope),
          created_at: s.created_at,
          updated_at: s.updated_at,
        }),
      );
    case "notify_channels":
      return chans.map((c) =>
        canonicalJson({
          kind: c.kind,
          config: c.config,
          template_overrides: c.template_overrides,
          enabled: c.enabled,
          created_at: c.created_at,
          updated_at: c.updated_at,
        }),
      );
    case "alert_rules":
      return rowsOf(data, "alert_rules").map((r) =>
        canonicalJson({
          host: hostKeyOf(r.host_id),
          kind: r.kind,
          params: r.params,
          channels: (Array.isArray(r.channels) ? r.channels : [])
            .map((id) => chanKeyOf(id))
            .sort(),
          rate_limit: r.rate_limit,
          mute_window: r.mute_window,
          created_at: r.created_at,
          updated_at: r.updated_at,
        }),
      );
    case "cron_jobs":
      return rowsOf(data, "cron_jobs").map((j) =>
        canonicalJson({
          host: hostKeyOf(j.host_id),
          schedule: j.schedule,
          script: j.script,
          channels: (Array.isArray(j.channels) ? j.channels : [])
            .map((id) => chanKeyOf(id))
            .sort(),
          enabled: j.enabled,
          created_at: j.created_at,
          updated_at: j.updated_at,
        }),
      );
    case "settings":
      return rowsOf(data, "settings").map((s) =>
        canonicalJson({ key: s.key, value: s.value }),
      );
  }
}

/** 凭据条目投影（无自然名——全部内容字段即身份；重映射不改内容，不变量成立）。 */
const credentialEntry = (c: Row): string =>
  canonicalJson({
    kind: c.kind,
    key_pub: c.key_pub,
    secret: c.secret,
    passphrase: c.passphrase,
    totp_secret: c.totp_secret,
    created_at: c.created_at,
    updated_at: c.updated_at,
  });

/** 单分类内容指纹（冲突明细的比对粒度）——canonical 投影后排序取哈希，
 * 对 id 重映射与行序不敏感（I-2）。 */
export async function categoryFingerprint(
  data: SyncData,
  cat: SyncCategory,
): Promise<string> {
  return sha256Hex(canonicalJson([...canonicalEntries(cat, data)].sort()));
}

// --- 冲突列表 ------------------------------------------------------------------

/** 逐分类冲突条目（粒度裁定：全量替换语义下分类 = 人工处理的最细可控粒度，
 * 见 task-3-report「对裁定的粒度澄清」；本机值/云端值 = 条数 + 内容指纹）。
 * 指纹基于自然键 canonical 投影（I-2）：只含有**真分歧**的分类——id 重映射、
 * 行序差异等非内容差异不进列表。 */
export interface CategoryConflict {
  category: SyncCategory;
  local_count: number;
  remote_count: number;
  local_fp: string;
  remote_fp: string;
}

/**
 * 双改冲突列表：逐分类以 canonical 投影比对本机与云端快照内容，指纹不同的
 * 分类进列表（canonical 序；`cats` 缺省 = 全八类——冲突明细不受范围勾选裁剪，
 * 展示完整分歧面，应用哪侧由 Task 4 UI 按分类裁定）。
 */
export async function buildConflictList(
  local: SyncData,
  remote: SyncData,
  cats: readonly SyncCategory[] = SYNC_CATEGORIES,
): Promise<CategoryConflict[]> {
  const out: CategoryConflict[] = [];
  for (const cat of SYNC_CATEGORIES) {
    if (!cats.includes(cat)) continue;
    const localRows = local.categories[cat] ?? [];
    const remoteRows = remote.categories[cat] ?? [];
    const [local_fp, remote_fp] = await Promise.all([
      categoryFingerprint(local, cat),
      categoryFingerprint(remote, cat),
    ]);
    if (local_fp === remote_fp) continue; // 该类无真分歧，不进冲突列表
    out.push({
      category: cat,
      local_count: localRows.length,
      remote_count: remoteRows.length,
      local_fp,
      remote_fp,
    });
  }
  return out;
}
