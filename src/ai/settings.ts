// AI 设置读写（Task 13）：BYOK provider 列表 / 脱敏配置 / 诊断开关 / 成本护栏，
// 真源 = vault settings（明文 JSON 面）+ vault secrets（api key 密文面）。
// settings 键面（T13 裁定）：
//   ai_providers  — ProviderMeta[]（**不含 apiKey**；key 走 secrets）
//   redaction     — { hostname: boolean; custom: RedactRule[] }
//   ai.enabled    — 诊断自动触发总开关（默认 true）
//   ai.max_tokens — 单请求上限（默认 1024，Rust 写入侧 ≤8192 校验）
//   ai.summary.enabled — 会话纪要独立开关（BL-510④ 清偿，默认 true）；
//     ai.enabled 语义 = 「命令失败自动诊断」，不管纪要链（summary.ts 同口径）
import { vaultApi } from "../vault/api";
import type { ProviderMeta } from "./openai";
import type { RedactRule } from "./redact";

/** AI 诊断输出尾部取多少字节（spec §6 定值 8KB）。 */
export const TAIL_BYTES = 8 * 1024;

/** 单请求 token 上限缺省（Rust AI_MAX_TOKENS_LIMIT=8192 为写入上限）。 */
export const DEFAULT_MAX_TOKENS = 1024;

export interface RedactionConfig {
  /** 主机名规则开关（默认开；其余默认规则恒开——IP/密码/邮箱无争议面）。 */
  hostname: boolean;
  /** 自定义规则（正则源串；保存前由设置页预检编译）。 */
  custom: RedactRule[];
}

export const DEFAULT_REDACTION: RedactionConfig = { hostname: true, custom: [] };

export interface AiSettings {
  enabled: boolean;
  /** 会话纪要独立开关（BL-510④；与 ai.enabled 诊断开关互不管辖）。 */
  summaryEnabled: boolean;
  maxTokens: number;
  providers: ProviderMeta[];
  redaction: RedactionConfig;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  summaryEnabled: true,
  maxTokens: DEFAULT_MAX_TOKENS,
  providers: [],
  redaction: DEFAULT_REDACTION,
};

/** 单项读取失败不互相拖累：每个键独立 try/catch，坏值回落默认（与
 * SessionStore.loadSettings 同口径——配置错误不该打死功能面）。 */
export async function loadAiSettings(): Promise<AiSettings> {
  const results = await Promise.allSettled([
    vaultApi.settings.get<ProviderMeta[]>("ai_providers"),
    vaultApi.settings.get<RedactionConfig>("redaction"),
    vaultApi.settings.get<boolean>("ai.enabled"),
    vaultApi.settings.get<number>("ai.max_tokens"),
    vaultApi.settings.get<boolean>("ai.summary.enabled"),
  ]);
  const [providers, redaction, enabled, maxTokens, summaryEnabled] = results.map((r) =>
    r.status === "fulfilled" ? r.value : undefined,
  ) as [
    ProviderMeta[] | undefined,
    RedactionConfig | undefined,
    boolean | undefined,
    number | undefined,
    boolean | undefined,
  ];
  return {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULT_AI_SETTINGS.enabled,
    summaryEnabled:
      typeof summaryEnabled === "boolean"
        ? summaryEnabled
        : DEFAULT_AI_SETTINGS.summaryEnabled,
    maxTokens:
      typeof maxTokens === "number" && maxTokens > 0 && maxTokens <= 8192
        ? Math.floor(maxTokens)
        : DEFAULT_MAX_TOKENS,
    providers: Array.isArray(providers) ? providers : [],
    redaction:
      redaction && typeof redaction === "object"
        ? {
            hostname: redaction.hostname !== false,
            custom: Array.isArray(redaction.custom) ? redaction.custom : [],
          }
        : { ...DEFAULT_REDACTION },
  };
}

/** 保存 provider 列表（全量替换）。列表首个 = 默认 provider（「设为默认」=
 * 移到首位，无独立 default 键——单键少一处漂移面）。 */
export function saveProviders(providers: ProviderMeta[]): Promise<void> {
  return vaultApi.settings.set("ai_providers", providers);
}

/** 保存脱敏配置。 */
export function saveRedaction(redaction: RedactionConfig): Promise<void> {
  return vaultApi.settings.set("redaction", redaction);
}

/** 保存诊断开关 / token 上限。 */
export function saveAiEnabled(enabled: boolean): Promise<void> {
  return vaultApi.settings.set("ai.enabled", enabled);
}

/** 保存会话纪要独立开关（BL-510④）。 */
export function saveAiSummaryEnabled(enabled: boolean): Promise<void> {
  return vaultApi.settings.set("ai.summary.enabled", enabled);
}

export function saveAiMaxTokens(maxTokens: number): Promise<void> {
  return vaultApi.settings.set("ai.max_tokens", maxTokens);
}

/** provider 的 secrets 键（逻辑名约定，secrets.rs 同源）。 */
export function apiKeySecretKey(providerId: string): string {
  return `ai.apikey.${providerId}`;
}
