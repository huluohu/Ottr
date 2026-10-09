// 会话纪要（Phase 2 B1，Task 7）：会话收尾 → history（本会话 session_id 的命令
// 序列）→ 脱敏（redact）→ 单轮摘要（**非流式**，max_tokens 512）→
// session_summaries 密文入库 → notify kind=ai（T12 管线，T13 先例）。
//
// 触发语义（task-7 裁定 #1）：
//   * 会话收尾三时机由 SessionStore 钩子派发（setSessionEndHook，App 注入
//     onSessionEnded）：①closeTab（关标签）②disconnect（手动断开）③自动重连
//     耗尽转 disconnected——手动断开也生成（纪要价值在复盘，手动断开同样是
//     会话结束）；
//   * 异常断开若自动重连还在进行则**不**生成（session_id 跨重连稳定，会话可
//     能继续；重连耗尽才是终态；upsert 同 (host_id, session_id) 覆盖旧纪要）；
//   * 「连接失败未成会话」不生成——数据源闸门（命令数 ≥3）天然覆盖：未成会
//     话 = 0 条历史，取数后即退出（连 settings/provider 都不碰）。
//
// 护栏（与 aiStore/nl2cmd 同纪律）：
//   * fire-and-forget：generateSessionSummary 恒不抛（失败 console.warn 静默，
//     返回 false）——纪要是尽力而为的副产物，绝不反噬关闭/断开流程；
//   * 命令序列先 redact 再进 prompt（裁定：摘要内容含命令序列，敏感面）——
//     与诊断链路同面（命令已落盘）；提示符前缀剥离（stripPromptPrefix，噪声
//     不进 prompt）；占位符原样进出（还原即泄露）；
//   * BYOK 直连：明文 key 只经 vault secrets 单点出库 → createProvider 请求头；
//   * ai.enabled **不管**本链路：该开关语义是「命令失败自动诊断」（设置页文案
//     与 T13/T6 口径一致）；纪要独立开关 = `ai.summary.enabled`（BL-510④ 清偿，
//     默认开，设置页同区可见）；未配 provider 即天然全关。
//   * 无 abort：后台任务没有面板生命周期，进程退出即终止（LLM 端点超时自灭）。
import i18n from "../i18n";
import { notify } from "../notify/core";
import { vaultApi } from "../vault/api";
import { createProvider, type AIProvider, type ChatMessage } from "./provider";
import { redact } from "./redact";
import { apiKeySecretKey, loadAiSettings } from "./settings";
import { stripPromptPrefix } from "../history/format";

/** 生成门槛：会话命令数 ≥3（少于 3 条的会话没有纪要价值，也天然排除
 * 「连接失败未成会话」）。 */
export const SUMMARY_MIN_COMMANDS = 3;

/** 摘要单请求 token 上限（裁定 #2：3-5 句纪要，512 足够；不受 ai.max_tokens
 * 设置面——那是交互式对话的成本护栏，后台摘要取更紧的定值）。 */
export const SUMMARY_MAX_TOKENS = 512;

/** 进入 prompt 的命令条数上限（Rust history_list_session 缺省同值；超长会话
 * 只摘要最近 N 条，prompt 体量护栏）。 */
export const SUMMARY_COMMANDS_LIMIT = 200;

/** 纪要生成请求的装配面（纯函数；命令须已脱敏 + 剥提示符，测试直接断言）。 */
export interface SummaryPrompt {
  system: string;
  user: string;
}

/** 装配 system/用户消息（i18n 模板；命令逐条编号，时间顺序即数组顺序）。 */
export function buildSummaryPrompt(commands: string[]): SummaryPrompt {
  const user = [
    `${i18n.t("ai.summary.header")}:`,
    ...commands.map((c, i) => `${i + 1}. ${c}`),
  ].join("\n");
  return {
    system: i18n.t("ai.summary.prompt"),
    user,
  };
}

/** 会话收尾信息（SessionStore 钩子入参；生成链只需要归属三元组）。 */
export interface SessionEndInfo {
  hostId: number;
  /** 前端会话 id（标签 uuid，跨重连稳定——history.session_id 同源）。 */
  id: string;
  hostName: string;
}

export interface GenerateSummaryOptions {
  /** 测试注入（MockProvider）；缺省 = 按 settings 组装真 provider。 */
  provider?: AIProvider;
}

/**
 * 生成一条会话纪要（数据源 → 脱敏 → 单轮摘要 → 密文入库 → 通知）。
 * 返回是否生成成功（各失败分支 false；**恒不抛**——fire-and-forget 纪律，
 * 绝不反噬断开/关闭流程）。链路逐段静默：
 *   history 取数失败 / 命令数 < 3 / 未配 provider / vault 锁定（派发前闸门，
 *   BL-510①）/ key 读取失败 / 端点错误 / 空回复 / 入库失败 → false
 *   （console.warn 留痕）。
 */
export async function generateSessionSummary(
  req: SessionEndInfo,
  opts: GenerateSummaryOptions = {},
): Promise<boolean> {
  try {
    // --- 1. 数据源（最便宜的闸门先行：未成会话 0 条历史，直接退出）---
    let rows;
    try {
      rows = await vaultApi.history.listSession(
        req.hostId,
        req.id,
        SUMMARY_COMMANDS_LIMIT,
      );
    } catch (e) {
      console.warn("[summary] history fetch failed:", e);
      return false;
    }
    if (rows.length < SUMMARY_MIN_COMMANDS) return false;

    // --- 2. 设置 + provider（未配置 = 纪要功能天然全关）---
    let settings;
    try {
      settings = await loadAiSettings();
    } catch (e) {
      console.warn("[summary] settings load failed:", e);
      return false;
    }
    const meta = settings.providers[0] ?? null;
    if (!meta) return false;

    // --- 2.4 独立开关闸门（BL-510④）：ai.summary.enabled 只管本链路（诊断链
    // 的 ai.enabled 语义不变）；关闭 = 用户裁量不出网，静默 false 即可。
    if (!settings.summaryEnabled) return false;

    // --- 2.5 锁定态前置闸门（BL-510①）：vault 锁定时 summary_insert 必被拒
    // （密文面过 ensure_unlocked 门卫）——现状是请求已发出、入库被拒静默丢，
    // 还会留下一条「纪要就绪」的谎报通知。派发前先查锁定态：锁定即止损不出网，
    // 失败原因 console.warn 留痕（不静默）。查询本身失败同样跳过（fail-closed
    // ——宁可漏一条尽力而为的纪要，不赌一次白烧；insert 门卫仍是权威边界）。
    let lockStatus;
    try {
      lockStatus = await vaultApi.security.status();
    } catch (e) {
      console.warn("[summary] lock status unavailable, skip:", e);
      return false;
    }
    if (lockStatus?.locked) {
      console.warn("[summary] vault locked, skip summary (insert would be rejected)");
      return false;
    }

    // --- 3. 明文 key 单点出库（空串 = 免 key 端点，同 aiStore fix 1/5 I-1）---
    let apiKey: string;
    try {
      apiKey = (await vaultApi.secrets.get(apiKeySecretKey(meta.id))) ?? "";
    } catch (e) {
      console.warn("[summary] api key load failed:", e);
      return false;
    }

    // --- 4. 脱敏 + 装配（命令序列先 redact 再进 prompt；提示符噪声剥离）---
    const redactOpts = {
      hostname: settings.redaction.hostname,
      custom: settings.redaction.custom,
    };
    const commands = rows.map((r) => redact(stripPromptPrefix(r.command), redactOpts).text);
    const prompt = buildSummaryPrompt(commands);
    const messages: ChatMessage[] = [{ role: "user", content: prompt.user }];

    // --- 5. 单轮非流式（后台任务不需要流式；聚合全部增量）---
    const provider = opts.provider ?? createProvider(meta, apiKey);
    let answer = "";
    for await (const delta of provider.chat({
      system: prompt.system,
      messages,
      maxTokens: SUMMARY_MAX_TOKENS,
    })) {
      answer += delta.text;
    }
    const summary = answer.trim();
    if (!summary) {
      console.warn("[summary] empty answer, skip");
      return false;
    }

    // --- 6. 密文入库（锁定即拒 → false 静默）---
    await vaultApi.summaries.insert({
      host_id: req.hostId,
      session_id: req.id,
      summary,
      command_count: rows.length,
    });

    // --- 7. 完成落通知（T12 管线 kind=ai，T13 先例；失败只记 console 不反噬）---
    try {
      await notify({
        kind: "ai",
        severity: "info",
        host_id: req.hostId,
        title_key: "notify.title.summaryReady",
        body: req.hostName,
        payload: { session_id: req.id, command_count: rows.length },
      });
    } catch (e) {
      console.warn("[summary] notify failed:", e);
    }
    return true;
  } catch (e) {
    console.warn("[summary] generation failed:", e);
    return false;
  }
}

/**
 * 同 session 在途去抖表（BL-510③）：disconnect 与 closeTab 双路径都会对同一
 * 会话派发收尾（先断开再关标签的常见时序）——在途期间第二次派发直接复用首次
 * 的生成（不重复出网、不重复入库；现状靠 UNIQUE upsert 兜底 = 白烧一次 LLM）。
 * 结算即出表：后续新收尾照常重新生成。
 */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * 会话收尾入口（SessionStore 钩子；App 注入 setSessionEndHook）。
 * fire-and-forget：同步返回，失败静默——调用方（closeTab/disconnect 状态机）
 * 不感知纪要链路的存在。
 */
export function onSessionEnded(info: SessionEndInfo): void {
  if (inFlight.has(info.id)) return; // 在途：复用首次生成的结果，不重复派发
  const p = generateSessionSummary(info);
  inFlight.set(info.id, p);
  void p.finally(() => inFlight.delete(info.id)).catch((e) => {
    console.warn("[summary] session end chain failed:", e);
  });
}
