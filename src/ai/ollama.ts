// Ollama 预设（Task 13 简报 Files 清单点名 ollama.ts）：Ollama 的 OpenAI 兼容
// 端点（/v1）直接复用 OpenAICompatibleProvider——本文件只是**预设工厂**（默认
// baseURL / 无鉴权），不是第三套实现。设置页 provider kind=openai-compatible +
// baseURL=http://localhost:11434/v1 即等价。
import { OpenAICompatibleProvider } from "./openai";

/** Ollama 本地默认端点（OpenAI 兼容路由，Ollama ≥0.1.24）。 */
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

export function createOllamaProvider(model: string, baseURL = OLLAMA_DEFAULT_BASE_URL) {
  // Ollama 本地无需鉴权：空 key = 不发 Authorization 头（openai.ts 约定）
  return new OpenAICompatibleProvider(baseURL, "", model);
}
