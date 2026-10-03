// 命令历史入库（Task 15，spec §5 文本层消费方③）：CommandWatch 的全量命令
// 完成事件 → `history_insert`（async fire-and-forget，绝不阻塞终端）。
//
// 路径裁定（简报）：前端 CommandWatch（xterm OSC133/OSC7 监听）为唯一入库源，
// Rust 侧不建第二条 OSC 解析管线（T13 评审裁定「能复用就复用」）。逐条插入
// （SQLite 本地写毫秒级），失败静默吞（历史是尽力而为的副簿，丢一条不该在
// 终端上冒错误横幅；vault 锁定态也照常可写——history 是明文面，不过门卫）。
//
// 脱敏不在历史层做（spec 定案：历史是本地数据）。入库上限（5 万条滚动清理）
// 在 Rust 存储层（ottr-vault History::insert 顺手 prune），前端无策略。
//
// 缺陷 45（审计截图「无 shell 集成会话把输出行收进历史」，2026-10-04 裁定）：
// **保守停用**非完整集成会话的历史入库（宁缺勿污，启发式门控不做）。判定源 =
// CommandWatch 的 `integrated` 标志（命令文本来自真实 OSC133 C 边界）：
// Ottr 注入的 bash/zsh 片段每条命令都发 C（DEBUG trap / preexec）→ true；
// 只发 D 的部分集成形态（用户自带残缺集成 / 注入被跳过的会话）走 D-without-C
// 回退，提取到的是**输出行/提示符行**——这些「伪命令」一律不入库。代价：用户
// 自带完整集成（非 Ottr 注入）的会话也停写历史——可接受（宁缺勿污）。
import { vaultApi, type HistoryInput } from "../vault/api";
import type { CommandFinishedEvent } from "../terminal/CommandWatch";

/** 入库上下文（会话维度的归属字段，调用方从 SessionStore 现取）。 */
export interface RecordContext {
  hostId: number;
  /** 前端会话 id（标签 uuid，跨重连稳定；rustId 每次重连都换，不用）。 */
  sessionId: string;
}

/**
 * shell 集成注入行的回声/完成事件过滤（attach 首窗噪声）：
 * 集成片段（ottr-ssh shell_integration）作为一条命令行发给交互式 shell，
 * 该行回显 + 它自己的完成事件（首个 D）都会被 CommandWatch 当成「命令」
 * 提取出来——特征是含片段源码的片段标志串，逐项显式过滤，其他一切照记。
 */
export function isIntegrationNoise(command: string): boolean {
  return (
    command.includes("133;") ||
    command.includes("PROMPT_COMMAND") ||
    command.includes("__osc133_preexec") ||
    command.includes("precmd(){") ||
    command.includes("file://%s")
  );
}

// --- 双 D 去重（fix 1/5） -----------------------------------------------------
// 注入幂等探测的已知盲区（慢 shell 首提示符晚于稳定窗 → 误判未集成而重复注入）
// 下，同一命令的完成事件可能收到两次（双集成的 precmd 同提示符各发一次 D）。
// 同 host+command+**秒级时间戳** 的重复完成事件只入一条：双 D 事件间隔毫秒级
// 必同秒；而真人 1 秒内原样重跑同一命令的场景近乎不存在（且损失可忽略）。
// 容量 16 的 FIFO（双集成最多每提示符 2 事件，16 覆盖 8 条命令窗口，集合有界）。

const DEDUP_CAP = 16;
const recentInsertKeys = new Map<string, true>();

/** 去重键（纯函数，可测）：hostId | command | 秒级时间戳。 */
export function dedupKey(ctx: RecordContext, ev: CommandFinishedEvent, nowMs: number): string {
  return `${ctx.hostId}|${ev.command}|${Math.floor(nowMs / 1000)}`;
}

/** 已见则 true；未见则记账（FIFO 驱逐最老键）后 false。 */
function seenRecently(key: string): boolean {
  if (recentInsertKeys.has(key)) return true;
  recentInsertKeys.set(key, true);
  if (recentInsertKeys.size > DEDUP_CAP) {
    const oldest = recentInsertKeys.keys().next().value;
    if (oldest !== undefined) recentInsertKeys.delete(oldest);
  }
  return false;
}

/** 测试隔离用：清空去重窗口（生产不调用）。 */
export function resetDedupForTests(): void {
  recentInsertKeys.clear();
}

/** 组装入库载荷（纯函数，可测）：空白命令丢弃（提示符噪声/纯回声）；
 * `integrated=false`（无完整 shell 集成的会话，缺陷 45）→ null 保守停用。 */
export function historyPayload(
  ctx: RecordContext,
  ev: CommandFinishedEvent,
): HistoryInput | null {
  if (!ev.integrated) return null;
  const command = ev.command.trim();
  if (!command || isIntegrationNoise(command)) return null;
  return {
    host_id: ctx.hostId,
    command,
    cwd: ev.cwd,
    exit_code: ev.exitCode,
    session_id: ctx.sessionId,
  };
}

/** 命令完成 → 入库（fire-and-forget：不 await、失败不抛、不阻塞终端）。
 * 入库前过双 D 去重（同 host+command+同秒只入一条，见上）。 */
export function recordCommand(ctx: RecordContext, ev: CommandFinishedEvent): void {
  const input = historyPayload(ctx, ev);
  if (!input) return;
  if (seenRecently(dedupKey(ctx, ev, Date.now()))) return;
  void vaultApi.history.insert(input).catch(() => {
    // 历史入库失败静默（尽力而为副簿；诊断/终端主路径不受影响）
  });
}
