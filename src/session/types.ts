// 会话域类型（自 SessionStore.ts 拆出，2026-10-08 遗留项②）：状态机类型 +
// 事件载荷同构面。公共 API 经 SessionStore.ts 的 export * 保持原路径不变。
import type { HostProtocol } from "../vault/api";
import type { SessionEncoding } from "./encoding";

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "waiting_host_key";

/** `ottr://host-key-ask` 事件载荷（Rust HostKeyAskPayload 同构，serde snake_case）。
 * 跳板链逐跳问询（Phase 2 Task 2）：host_id = 该跳自己的主机 id（裁定时按它
 * 落端点信任锚）；hop = 跳序号（0 起，弹窗带「第 N 跳」标识）；origin_host_id =
 * 发起连接的主机（问询归属在途 connect 的标签）。直连问询两字段缺省。 */
export interface HostKeyAskPayload {
  host_id: number;
  host_name: string;
  fingerprint: string;
  kind: "first" | "pending" | "changed";
  hop?: number;
  origin_host_id?: number;
}

/** 弹窗态的问询（挂上发起问询的会话）。 */
export interface HostKeyAsk extends HostKeyAskPayload {
  sessionId: string;
}

/** `ottr://session-closed` 事件载荷（Rust SessionClosedPayload 同构）。 */
export interface SessionClosedPayload {
  id: string;
  reason: "cancelled" | "closed" | "ipc_failed";
}

export interface Session {
  /** 标签 id（uuid，跨重连稳定）；Rust 会话 id 另存 rustId。 */
  id: string;
  hostId: number;
  hostName: string;
  address: string;
  port: number;
  username: string | null;
  /** 主机协议（Phase 2 Task 5）：ftp/ftps = 纯文件会话（无 PTY 终端）。 */
  protocol: HostProtocol;
  /** 跳板链归属（host.jump_chain_id 会话内拷贝；分屏 pane 与标签同源）：
   * 非空 = attach 走链式路径，Rust 侧 connect 预算 = 75s×(跳数+1)——
   * attach 看门狗只护直连（见 ATTACH_WATCHDOG_MS 注释），链式不武装。 */
  jumpChainId: number | null;
  status: SessionStatus;
  /** 当前 Rust 侧会话 id（attach 成功后非空；重连期间清空）。 */
  rustId: string | null;
  /** 已进行的自动重连次数（0 = 从未断线/已成功复位）。 */
  attempt: number;
  lastError: string | null;
  /** 下一次自动重连的绝对时刻（Date.now 基）；null = 无挂起重连。 */
  nextRetryAt: number | null;
  /** 分屏归属（Task 8）：null = 标签根会话（TabBar 只渲染根）；
   * 非空 = 所属标签根会话 id（一个标签一棵 pane 树，树叶 id = 会话 id）。 */
  paneOf: string | null;
  /** 会话编码（Task 9，A9）：初值 = host encoding_override（支持集内）兜底
   * utf-8；setSessionEncoding 切换（即切即生效，不写回 host）。
   * 【语义裁定（fix 1/5）】重连=新会话：connect 成功后编码一律从
   * encodingOverride 重新派生——手动切换只活在当前连接内，不跨重连。 */
  encoding: SessionEncoding;
  /** host.encoding_override 的派生值（支持集内，兜底 utf-8；重连下发源）。 */
  encodingOverride: SessionEncoding;
  /** detect_hint 提示（Rust `ottr://encoding-hint`）：非空 = 展示
   * 「检测到 GBK，切换？」提示条；接受/忽略后清空（per-host 一次，可关）。 */
  encodingHint: SessionEncoding | null;
  /** 生产环境主机标记（Phase 2 Task 11，B11）：终端 pane 红框 + TabBar PROD
   * 徽标的依据；host.is_production 的会话内拷贝（分屏 pane 与标签同源）。 */
  isProduction: boolean;
  /** 监控开关（Phase 3 Task 1，B4 上半）：host.monitor_enabled 的会话内拷贝。
   * attach 成功后按它决定是否 monitor_start（仅标签根会话——分屏 pane 与根
   * 同主机，多份采样是纯浪费；面板消费面在 MonitorSidebar）。可选 = 存量测试
   * 夹具/旧构造点不必逐个补字段，消费面统一 `=== true`（缺省关，安全侧）。 */
  monitorEnabled?: boolean;
}
