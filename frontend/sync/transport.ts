// 同步传输层契约（Phase 5 Task 2）——三通道（WebDAV / Git / 本地目录）的
// 统一最小面，沿渠道适配器模式（frontend/notify/channels/）：
//   * 接口只认信封（SyncEnvelope），通道细节（HTTP/git/fs）全部内敛在实现里；
//   * 可注入 deps（fetchImpl/exec/fs 后端）——单测零真网、端到端真夹具两栖
//     （e2e.trzsz.test.ts / channels.test.ts 同纪律）；
//   * 消费方 = Task 3 同步编排（fetch → 冲突判定 → push）。
//
// 信封语义（错误通道）：
//   * fetch() 返回 null = 远端无信封（首次同步/空仓库/文件不存在）——不是错误；
//   * fetch() 抛错 = 通道故障（网络/认证/格式损坏）——编排层不吞；
//   * push() 覆盖写 = last-writer-wins 声明：并发保护不在传输层（WebDAV/本地
//     目录是裸覆盖，Git 有 clone-newest-then-push 的窄窗乐观锁），真正的双改
//     检测在 Task 3 编排层（上次同步快照指纹 vs 本机 vs 远端，逐条人工裁定）。
import type { SyncEnvelope } from "./envelope";
import { parseEnvelope } from "./envelope";

/** 三通道统一契约。kind 用于错误信息与 Task 4 配置 UI 的通道标识。 */
export interface SyncTransport {
  /** 通道标识："webdav" | "git" | "localdir"。 */
  readonly kind: string;
  /** 拉取远端信封；远端无信封（首次）返回 null。格式损坏/通道故障抛错。 */
  fetch(): Promise<SyncEnvelope | null>;
  /** 推送信封（覆盖远端；last-writer-wins，见文件头声明）。 */
  push(envelope: SyncEnvelope): Promise<void>;
  /** 连通性测试（Task 4「测试连接」按钮）：true = 可达且可读（文件尚不存在
   * 也算可达）；false = 认证失败/不可达/未授权。不抛错（布尔面直给 UI）。 */
  test(): Promise<boolean>;
}

/** 信封 JSON 落地后的统一校验出口（格式语义归 envelope.parseEnvelope）。 */
export function parseEnvelopeJson(text: string): SyncEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("sync payload is not valid JSON");
  }
  return parseEnvelope(raw);
}
