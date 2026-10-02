// 同步编排（Phase 5 Task 3）——push / pull / status 三动作的状态机壳。
//
// 组成（Task 2 传输层 + Task 3 数据面之上的薄编排层）：
//   * Rust 数据面：sync_export_categories / sync_import_categories（分类快照
//     导出/导入，id 重映射与全量替换语义在 ottr-vault sync_snapshot）；
//   * 信封加密：envelope.ts seal/open（信封口令独立于本机主密码——双层加密，
//     论证见 task-3-report）；传输：SyncTransport 三通道（Task 2）；
//   * 状态基线：settings `sync.state` = { remote_fp, local_fp, saved_at }——
//     存 settings JSON 而非新表（选型论证见 task-3-report：单行 KV、无查询面、
//     损坏即重建基线，建表不成比例）；
//   * 判定：engine.ts judgeThreeState（纯函数，表驱动 TDD）。
//
// 流程契约：
//   push  = 导出全八类 → 本机指纹 → 范围过滤入信封 → seal → transport.push
//           → 基线 { sha256(信封JSON), 本机指纹 }；
//   pull  = fetch → 开封 → 范围内分类全量替换导入 → 重导出 → 基线；
//   status= 双指纹 + 基线 → 三态判定；conflict 时（可选口令）开封列逐分类明细。
//
// 错误通道：传输故障/口令错原样上抛（fetch null 语义 = 远端无信封，见
// transport.ts 文件头）；pull 在远端无信封时显式报错（pull 无从谈起）。

import type { SyncTransport } from "./transport";
import {
  openEnvelope,
  sealEnvelope,
  utf8,
  type SyncEnvelope,
} from "./envelope";
import {
  SYNC_CATEGORIES,
  asSyncData,
  buildConflictList,
  fingerprint,
  filterSnapshot,
  isEmptySnapshot,
  judgeThreeState,
  type CategoryConflict,
  type SyncAction,
  type SyncCategory,
  type SyncData,
  type SyncStateSnapshot,
} from "./engine";

/** settings 键：三态判定基线。 */
export const SYNC_STATE_KEY = "sync.state";
/** settings 键前缀：范围勾选偏好（push / restore 各自一份）。 */
export const SCOPE_PUSH_KEY = "sync.scope.push";
export const SCOPE_RESTORE_KEY = "sync.scope.restore";

/** Rust 导入回执（SyncImportReport 同构）。 */
export interface SyncImportReport {
  applied: Record<string, number>;
  skipped: Record<string, number>;
}

/** vault 命令面（生产 = tauriSyncBridge 的 invoke 接线；测试 = 假件）。 */
export interface SyncVaultBridge {
  exportCategories(cats: SyncCategory[]): Promise<SyncData>;
  importCategories(cats: SyncCategory[], data: unknown, mode: "replace"): Promise<SyncImportReport>;
  settingsGet<T = unknown>(key: string): Promise<T | null>;
  settingsSet(key: string, value: unknown): Promise<void>;
}

/** 生产接线：命令名与 src-tauri 注册逐字对齐。 */
export function tauriSyncBridge(): SyncVaultBridge {
  return {
    exportCategories: async (cats) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return asSyncData(await invoke("sync_export_categories", { cats }));
    },
    importCategories: async (cats, data, mode) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<SyncImportReport>("sync_import_categories", { cats, data, mode });
    },
    settingsGet: async <T,>(key: string) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<T | null>("settings_get", { key });
    },
    settingsSet: async (key, value) => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("settings_set", { key, value });
    },
  };
}

export interface SyncStoreDeps {
  bridge: SyncVaultBridge;
  transport: SyncTransport;
}

export interface PushResult {
  action: "push";
  localFp: string;
  remoteFp: string;
}

export interface PullResult {
  action: "pull";
  localFp: string;
  remoteFp: string;
  /** 逐分类落库/跳过计数（Rust SyncImportReport）。 */
  report: SyncImportReport;
}

/** status 回执：三态 + 冲突明细（仅 conflict 且能开封时非空）。 */
export interface SyncStatus {
  action: SyncAction;
  localFp: string;
  remoteFp: string | null;
  /** 远端是否存在信封。 */
  remoteExists: boolean;
  /** 基线是否存在（从未同步过 = null）。 */
  baseline: SyncStateSnapshot | null;
  /** 逐分类冲突明细：action = conflict 且 passphrase 可开封远端时给出。 */
  conflicts: CategoryConflict[] | null;
}

export interface SyncStore {
  /** 范围勾选（settings 偏好；未设置 = 全八类）。 */
  getScope(kind: "push" | "restore"): Promise<SyncCategory[]>;
  /** 保存范围勾选（非空 + 全法集校验；去重）。 */
  setScope(kind: "push" | "restore", cats: readonly SyncCategory[]): Promise<void>;
  /** 推送：范围 cats 省缺 = push 范围偏好。 */
  push(passphrase: string, cats?: readonly SyncCategory[]): Promise<PushResult>;
  /** 拉取应用：范围 cats 省缺 = restore 范围偏好。远端无信封 → 抛错。 */
  pull(passphrase: string, cats?: readonly SyncCategory[]): Promise<PullResult>;
  /** 三态判定（conflict 明细需要口令开封远端；passphrase 省缺 = 不开封）。 */
  status(passphrase?: string): Promise<SyncStatus>;
}

const ALL: SyncCategory[] = [...SYNC_CATEGORIES];

export function createSyncStore(deps: SyncStoreDeps): SyncStore {
  const { bridge, transport } = deps;

  function scopeKey(kind: "push" | "restore"): string {
    return kind === "push" ? SCOPE_PUSH_KEY : SCOPE_RESTORE_KEY;
  }

  async function resolveScope(
    kind: "push" | "restore",
    cats?: readonly SyncCategory[],
  ): Promise<SyncCategory[]> {
    if (cats) return normalizeScope(cats);
    return normalizeScope(((await bridge.settingsGet<SyncCategory[]>(scopeKey(kind))) ?? ALL));
  }

  /** 全八类导出 + 本机数据指纹（canonical JSON sha256）。 */
  async function exportAllWithFingerprint(): Promise<{ data: SyncData; localFp: string }> {
    const data = await bridge.exportCategories(ALL);
    return { data, localFp: await fingerprint(data) };
  }

  async function remoteFingerprint(): Promise<{ envelope: SyncEnvelope | null; remoteFp: string | null }> {
    const envelope = await transport.fetch();
    return { envelope, remoteFp: envelope === null ? null : await fingerprint(envelope) };
  }

  async function saveBaseline(localFp: string, remoteFp: string): Promise<SyncStateSnapshot> {
    const snapshot: SyncStateSnapshot = {
      remote_fp: remoteFp,
      local_fp: localFp,
      saved_at: Math.floor(Date.now() / 1000),
    };
    await bridge.settingsSet(SYNC_STATE_KEY, snapshot);
    return snapshot;
  }

  async function openRemoteData(envelope: SyncEnvelope, passphrase: string): Promise<SyncData> {
    const bytes = await openEnvelope(envelope, passphrase);
    return asSyncData(JSON.parse(utf8.decode(bytes)));
  }

  return {
    async getScope(kind) {
      return normalizeScope(((await bridge.settingsGet<SyncCategory[]>(scopeKey(kind))) ?? ALL));
    },

    async setScope(kind, cats) {
      await bridge.settingsSet(scopeKey(kind), normalizeScope(cats));
    },

    async push(passphrase, cats): Promise<PushResult> {
      if (passphrase === "") throw new Error("sync passphrase must not be empty");
      const scope = await resolveScope("push", cats);
      const { data, localFp } = await exportAllWithFingerprint();
      const payload = JSON.stringify(filterSnapshot(data, scope));
      const envelope = await sealEnvelope(payload, passphrase);
      await transport.push(envelope);
      const remoteFp = await fingerprint(envelope);
      await saveBaseline(localFp, remoteFp);
      return { action: "push", localFp, remoteFp };
    },

    async pull(passphrase, cats): Promise<PullResult> {
      if (passphrase === "") throw new Error("sync passphrase must not be empty");
      const { envelope, remoteFp } = await remoteFingerprint();
      if (envelope === null || remoteFp === null) {
        throw new Error("remote has no sync envelope to pull");
      }
      const data = await openRemoteData(envelope, passphrase);
      const scope = await resolveScope("restore", cats);
      const report = await bridge.importCategories(scope, data, "replace");
      const { localFp } = await exportAllWithFingerprint();
      await saveBaseline(localFp, remoteFp);
      return { action: "pull", localFp, remoteFp, report };
    },

    async status(passphrase): Promise<SyncStatus> {
      const { data: localData, localFp } = await exportAllWithFingerprint();
      const { envelope, remoteFp } = await remoteFingerprint();
      const baseline = await bridge.settingsGet<SyncStateSnapshot>(SYNC_STATE_KEY);
      const action = judgeThreeState({
        localFp,
        localEmpty: isEmptySnapshot(localData),
        remoteFp,
        snapshot: baseline,
      });
      let conflicts: CategoryConflict[] | null = null;
      if (action === "conflict" && envelope !== null && passphrase) {
        conflicts = await buildConflictList(localData, await openRemoteData(envelope, passphrase));
      }
      return {
        action,
        localFp,
        remoteFp,
        remoteExists: envelope !== null,
        baseline,
        conflicts,
      };
    },
  };
}

/** 范围校验：非空、全法集、去重（canonical 序输出）。 */
export function normalizeScope(cats: readonly SyncCategory[]): SyncCategory[] {
  if (cats.length === 0) throw new Error("sync scope must not be empty");
  const set = new Set<string>();
  for (const cat of cats) {
    if (!SYNC_CATEGORIES.includes(cat)) throw new Error(`unknown sync category: ${String(cat)}`);
    set.add(cat);
  }
  return SYNC_CATEGORIES.filter((c) => set.has(c));
}
