// AI 备忘注入（2026-11-02 批次一 A 项）：把主机「备注」变成 AI 可读的上下文。
//
// **载体裁定**：复用既有 `hosts.notes`（`crates/ottr-vault/migrations/
// 0002_entities.sql:58`）——零迁移成本、已在主机表单可编辑、已进 FTS 索引。
// 不新建 `ai_context` 列：导出面（SSH Config / CSV / Tabby）会把 notes 带
// 出去，专用列才干净，但那需要一条 0025 迁移 + 是否进 scan_registry 的裁定。
//
// **三条钉死的语义**：
// 1. **脱敏**——备忘是持久化在 vault 的数据，不是用户当前输入，必须过脱敏
//    引擎（与命令/输出尾同规则集）。内网地址、主机名、密码片段极易手写其中。
// 2. **长度上限**——备忘进 prompt 直接抬高 token 成本（BYOK 用户自掏腰包），
//    无上限等于让用户用备注页烧额度。
// 3. **失败不阻断**——取备注失败（主机已删 / IPC 错 / 无备注）一律回落
//    「无备忘段」，备忘是增强项而非前置条件。
import { vaultApi } from "../vault/api";
import { redact, type RedactFinding, type RedactOptions } from "./redact";

/** 注入 AI 上下文的备忘长度上限（字符）。 */
export const HOST_CONTEXT_MAX_CHARS = 2048;

/** 截断标记（超长时追加在被裁内容末尾）。 */
const TRUNCATION_MARK = "…";

export interface HostContextResult {
  /** 注入块文本（空串 = 无备注可注入）。 */
  text: string;
  /** 脱敏命中（并入调用方的脱敏统计）。 */
  findings: RedactFinding[];
}

/**
 * 备忘 → 注入块（纯函数；脱敏 + 长度裁剪 + 空值剔除）。
 *
 * 顺序：**先脱敏后裁剪**——先裁剪会让命中在裁剪边界处的敏感值漏网
 * （半个 IP 拼不进规则），脱敏后再裁剪则占位符天然短于原值。
 */
export function buildHostContextBlock(
  notes: string | null | undefined,
  redactOpts: RedactOptions,
): HostContextResult {
  const raw = (notes ?? "").trim();
  if (raw === "") return { text: "", findings: [] };

  const red = redact(raw, redactOpts);
  const body =
    red.text.length > HOST_CONTEXT_MAX_CHARS
      ? red.text.slice(0, HOST_CONTEXT_MAX_CHARS).trimEnd() + TRUNCATION_MARK
      : red.text;
  return { text: body, findings: red.findings };
}

/**
 * 按 hostId 取主机备注（进程内缓存；失败一律回落 null）。
 *
 * 缓存理由：AI 链每轮都要取备注，而 IPC 往返不便宜；主机备注在会话期间
 * 基本不变（用户改备注 → 下次取数自然读到新值，因为写入方会清缓存）。
 */
const notesCache = new Map<number, string | null>();

/** 缓存失效（主机保存后由调用方触发）。 */
export function invalidateHostNotes(hostId: number): void {
  notesCache.delete(hostId);
}

/** 清空缓存（测试用；也供「主机列表重载」这类全量刷新调用）。 */
export function clearHostNotesCache(): void {
  notesCache.clear();
}

/** 按 hostId 取备注（null = 无主机 / 无备注 / 取数失败——三者在 AI 链里等价）。 */
export async function fetchHostNotes(hostId: number | null): Promise<string | null> {
  if (hostId == null) return null;
  const cached = notesCache.get(hostId);
  if (cached !== undefined) return cached;
  try {
    const host = await vaultApi.hosts.get(hostId);
    const notes = host?.notes?.trim() ? host.notes : null;
    notesCache.set(hostId, notes);
    return notes;
  } catch {
    // 取数失败不是故障——备忘是增强项，缺失即无备忘段。
    notesCache.set(hostId, null);
    return null;
  }
}
