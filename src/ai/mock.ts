// MockProvider（Task 13 测试件）：把脚本字符串切块产出流；记录收到的请求供
// 断言（诊断链路测试用——断言 system/消息/脱敏后的内容/maxTokens）。
import type { ChatDelta, ChatRequest } from "./provider";

export class MockProvider {
  /** 收到的请求（chat 调用序列）。 */
  readonly requests: ChatRequest[] = [];

  constructor(private readonly script: string | string[]) {}

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    this.requests.push(req);
    const chunks = Array.isArray(this.script) ? this.script : [this.script];
    for (const chunk of chunks) {
      if (req.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      // 微任务让出：让消费方的 abort/状态推进有机会插队（模拟网络间隙）
      await Promise.resolve();
      yield { text: chunk };
    }
  }
}
