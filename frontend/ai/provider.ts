// AIProvider 接口（Task 13，spec §6 AI 服务层）：
//   * BYOK 直连——请求从 webview 直接 fetch 用户配置的端点，**无 Ottr 中转**
//     （tauri.conf CSP=null 现状不限制 connect-src，见 task-13-report CSP 记录）；
//   * 流式 = AsyncIterable<ChatDelta>；abort 走标准 AbortSignal（面板取消 =
//     controller.abort()，fetch/reader 以 AbortError 断开）；
//   * 三实现：OpenAICompatibleProvider（一个类覆盖 OpenAI/DeepSeek/Ollama 等
//     任意兼容端点）/ AnthropicProvider / MockProvider（测试）；
//   * baseURL 约定：OpenAI 兼容 = 已含版本前缀的根（如 https://api.openai.com/v1、
//     https://api.deepseek.com、http://localhost:11434/v1），本层只追加
//     /chat/completions；Anthropic = https://api.anthropic.com，本层追加 /v1/messages。
import { AnthropicProvider } from "./anthropic";
import { MockProvider } from "./mock";
import { OpenAICompatibleProvider, type ProviderMeta } from "./openai";

export { AnthropicProvider } from "./anthropic";
export { MockProvider } from "./mock";
export { OpenAICompatibleProvider } from "./openai";
export type { ProviderMeta } from "./openai";

/** 单条消息（system 走 ChatRequest.system 单列——Anthropic 的 system 是顶层参数）。 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  /** 系统提示词（诊断/解释场景的 i18n 模板）。 */
  system?: string;
  messages: ChatMessage[];
  /** 单请求 token 上限（成本护栏，settings ai.max_tokens，默认 1024）。 */
  maxTokens: number;
  /** 停止序列（可选；NL→命令场景钉「只输出一条命令」——模型一碰到即收口，
   * 端点侧兜底，客户端 sanitize 仍兜不服从的端点）。各实现的请求字段名
   * 差异在各自 provider 内换算（OpenAI `stop` / Anthropic `stop_sequences`）。 */
  stop?: string[];
  /** 取消信号（面板 abort）。 */
  signal?: AbortSignal;
}

/** 流式增量。 */
export interface ChatDelta {
  text: string;
}

/** Provider 实例（工厂入参 = 设置页元数据 + vault secrets 出库的明文 key）。 */
export interface AIProvider {
  /** 流式对话（诊断/解释场景唯一消费面）。 */
  chat(req: ChatRequest): AsyncIterable<ChatDelta>;
  /** 连通性自检（设置页「测试连接」）：非流式一发，返回模型回文；失败 reject
   * 带端点错误（HTTP 状态 + error.message）。 */
  testConnection(): Promise<string>;
}

/** provider 工厂：meta.kind 分派到对应实现；apiKey 明文只经本调用注入
 * （出库自 vault secrets，随请求头存活，不落任何全局）。kind "mock"（测试
 * 端点，批次三 T3）按 openai 兼容走协议——mock 语义只在设置页徽标（测试端点
 * 通常就是本地起一个 OpenAI 兼容假服务，见 BL-503 的 mock AI 脚本）。 */
export function createProvider(meta: ProviderMeta, apiKey: string): AIProvider {
  switch (meta.kind) {
    case "anthropic":
      return new AnthropicProvider(meta.baseURL, apiKey, meta.model);
    default:
      return new OpenAICompatibleProvider(meta.baseURL, apiKey, meta.model);
  }
}

/** 测试/无后端场景的工厂直通（mock 不需要 key）。 */
export function createMockProvider(script: string | string[]): MockProvider {
  return new MockProvider(script);
}
