// 补全历史缓存（Phase 2 Task 8，B8 数据面）。
//
// 选型裁定（简报/裁定书）：补全需要**前缀**查询，而 history_search 是子串
// 语义（≥3 字符 FTS trigram / <3 字符 LIKE %..%）——不为前缀匹配新开 Rust
// 查询命令或新迁移，复用 history_search 的**空查询语义**（= 该 host 最近 N
// 条，id DESC）拉取进前端内存，子串→前缀的收敛在纯引擎 suggest() 完成。
//
// 缓存形态：host 维度 Map + 一张全局表（hostId=null 拉取，跨主机冷启动也有
// 建议）。加载时机 = 会话装配（Terminal.tsx fire-and-forget）；增量 = T15
// recordCommand 的同一事件流（onCommandFinished）顺手 unshift（MRU 去重，
// 容量 200 滚动）。规范化与入库同口径：stripPromptPrefix 剥提示符 + 集成
// 噪声过滤 + 多行剔除（Tab 采纳多行会提前执行首行——安全红线）。
import { vaultApi } from "../vault/api";
import { stripPromptPrefix } from "./format";
import { isIntegrationNoise } from "./record";
import type { CompletionSources } from "../terminal/completion";

/** 单表拉取/容量上限（id DESC 最近 200 条，足够 prefix 命中面）。 */
export const COMPLETION_HISTORY_LIMIT = 200;

/** 单条规范化：剥提示符、去首尾空白；空/多行/集成噪声 → null（不入缓存）。 */
export function normalizeCommand(raw: string): string | null {
  const cmd = stripPromptPrefix(raw).trim();
  if (cmd === "" || cmd.includes("\n") || isIntegrationNoise(cmd)) return null;
  return cmd;
}

/** 列表规范化：逐条 normalize + 保序去重（首个出现 = 最近者）。 */
export function normalizeCommands(raws: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const cmd = normalizeCommand(raw);
    if (cmd === null || seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

/** MRU 前插：已有则移到队首，超容量裁尾。 */
function pushFront(list: string[], cmd: string, cap: number): string[] {
  return [cmd, ...list.filter((c) => c !== cmd)].slice(0, cap);
}

export class CompletionHistoryCache {
  private host = new Map<number, string[]>();
  private globalList: string[] | null = null;
  private inflight = new Map<number, Promise<void>>();

  /** 会话装配时拉一次（host 表 + 全局表并行；并发去重；失败静默——补全是
   * 尽力而为的增益面，取不到历史只剩内置表）。 */
  async ensure(hostId: number): Promise<void> {
    if (this.host.has(hostId) && this.globalList !== null) return;
    const existing = this.inflight.get(hostId);
    if (existing) return existing;
    const task = (async () => {
      const [hostRows, globalRows] = await Promise.all([
        vaultApi.history.search("", hostId, COMPLETION_HISTORY_LIMIT),
        this.globalList !== null
          ? Promise.resolve([])
          : vaultApi.history.search("", null, COMPLETION_HISTORY_LIMIT),
      ]);
      this.host.set(hostId, normalizeCommands(hostRows.map((r) => r.command)));
      if (this.globalList === null) {
        this.globalList = normalizeCommands(globalRows.map((r) => r.command));
      }
    })()
      .catch(() => undefined) // 失败静默（空缓存 = 只剩内置表，不阻塞终端）
      .finally(() => {
        this.inflight.delete(hostId);
      });
    this.inflight.set(hostId, task);
    return task;
  }

  /** 命令完成事件的增量入口（Terminal.tsx onCommandFinished 与 recordCommand
   * 同点调用；规范化不过关的静默丢弃）。 */
  append(hostId: number, rawCommand: string): void {
    const cmd = normalizeCommand(rawCommand);
    if (cmd === null) return;
    this.host.set(hostId, pushFront(this.host.get(hostId) ?? [], cmd, COMPLETION_HISTORY_LIMIT));
    this.globalList = pushFront(this.globalList ?? [], cmd, COMPLETION_HISTORY_LIMIT);
  }

  /** 引擎数据源现取（数组序 = 最近优先）。 */
  sources(hostId: number): CompletionSources {
    return {
      hostHistory: this.host.get(hostId) ?? [],
      globalHistory: this.globalList ?? [],
    };
  }

  /** 测试隔离用（生产不调用）。 */
  resetForTests(): void {
    this.host.clear();
    this.globalList = null;
    this.inflight.clear();
  }
}

/** 模块级单例（同 SearchAddon 注册表惯例：非响应式、跨会话共享）。 */
export const completionHistory = new CompletionHistoryCache();
