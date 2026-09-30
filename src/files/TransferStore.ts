// TransferStore（Task 10，A5）：传输队列全局状态机。
//
// 状态机（每条传输独立）：
//   startDownload/startUpload（invoke 成功）──▶ active ──end(done)──▶ done
//        │（事件先到的竞态：onBegin 先建 active 占位）      ├─end(failed)──▶ failed
//        ▼                                                └─end(cancelled)─▶ cancelled
//      active（begin 事件先于命令回执，同 transfer_id 合并去重）
//   active ──cancel()──▶ active（cancelling=true，等 Rust end 事件收尾；
//                         chunk 边界协作取消最坏延迟 ≈ 一个 chunk）
//   failed/cancelled ──retry()──▶ 新 transfer_id 的 active（旧条目移除；
//                         journal 按身份命中 → 断点续传，transferred 从上次进度起跳）
//
// 数据契约：前端 store 是队列的展示态（条目次序/进度/收尾状态）；权威进度来自
// `ottr://transfer-begin/progress/end` 事件（Rust 全局 emit，100ms 节流首末帧必发）。
// 队列并发：MVP 不设上限（每条传输各开一条 SFTP channel）；失败重试 = 同参数重发。
import { create } from "zustand";
import {
  fileNameOf,
  parentOf,
  sftpDownload,
  sftpUpload,
  transferCancel,
  type TransferStarted,
} from "./api";

export type TransferStatus = "active" | "done" | "failed" | "cancelled";
export type TransferKind = "download" | "upload";

export interface TransferItem {
  transferId: string;
  kind: TransferKind;
  remotePath: string;
  localPath: string;
  /** 发起时所在会话的 Rust 会话 id（retry 重发用）。 */
  rustId: string;
  total: number;
  transferred: number;
  status: TransferStatus;
  /** end(failed) 的错误文本。 */
  error: string | null;
  /** cancel() 已发出、等 Rust end 事件的过渡态（按钮防抖）。 */
  cancelling: boolean;
  startedAt: number;
}

/** `ottr://transfer-begin` 载荷（Rust TransferBeginPayload 同构）。 */
export interface TransferBeginPayload {
  transfer_id: string;
  kind: "download" | "upload";
  remote_path: string;
  local_path: string;
  total: number;
}

/** `ottr://transfer-progress` 载荷。 */
export interface TransferProgressPayload {
  transfer_id: string;
  transferred: number;
  total: number;
}

/** `ottr://transfer-end` 载荷。 */
export interface TransferEndPayload {
  transfer_id: string;
  status: "done" | "failed" | "cancelled";
  message: string;
}

interface TransferStore {
  items: TransferItem[];

  /** FilePanel：发起下载（远端 → 本地；local 缺省 = 下载目录）。 */
  startDownload: (rustId: string, remote: string, local?: string) => Promise<void>;
  /** FilePanel：发起上传（本地 → 远端目录；目标名 = 本地文件名，重名覆盖）。 */
  startUpload: (rustId: string, local: string, remoteDir: string) => Promise<void>;
  /** 取消（Rust chunk 边界协作退出；end 事件收尾）。未知 id 显式报错。 */
  cancel: (transferId: string) => Promise<void>;
  /** 失败/取消后重试：同参数重发（journal 续传），旧条目移除。 */
  retry: (transferId: string) => Promise<void>;
  /** 移除收尾条目（清空队列手动项）。 */
  dismiss: (transferId: string) => void;

  // 事件入口（events.ts 接线；独立导出便于测试直驱）
  onBegin: (p: TransferBeginPayload) => void;
  onProgress: (p: TransferProgressPayload) => void;
  onEnd: (p: TransferEndPayload) => void;
}

function patchItem(
  items: TransferItem[],
  transferId: string,
  patch: Partial<TransferItem>,
): TransferItem[] {
  return items.map((it) => (it.transferId === transferId ? { ...it, ...patch } : it));
}

export const useTransferStore = create<TransferStore>((set, get) => ({
  items: [],

  startDownload: async (rustId, remote, local) => {
    const fallback = local ?? null;
    const started: TransferStarted = await sftpDownload(rustId, remote, fallback ?? undefined);
    // 竞态容错：begin 事件可能先于命令回执落地（onBegin 已建占位）→ 合并不覆盖。
    const existing = get().items.find((it) => it.transferId === started.transfer_id);
    if (existing) {
      set((st) => ({
        items: patchItem(st.items, started.transfer_id, {
          total: started.total || existing.total,
          rustId,
        }),
      }));
      return;
    }
    set((st) => ({
      items: [
        ...st.items,
        {
          transferId: started.transfer_id,
          kind: "download",
          remotePath: started.remote_path,
          localPath: started.local_path,
          rustId,
          total: started.total,
          transferred: 0,
          status: "active",
          error: null,
          cancelling: false,
          startedAt: Date.now(),
        },
      ],
    }));
  },

  startUpload: async (rustId, local, remoteDir) => {
    const started: TransferStarted = await sftpUpload(rustId, local, remoteDir);
    const existing = get().items.find((it) => it.transferId === started.transfer_id);
    if (existing) {
      set((st) => ({
        items: patchItem(st.items, started.transfer_id, {
          total: started.total || existing.total,
          rustId,
        }),
      }));
      return;
    }
    set((st) => ({
      items: [
        ...st.items,
        {
          transferId: started.transfer_id,
          kind: "upload",
          remotePath: started.remote_path,
          localPath: started.local_path,
          rustId,
          total: started.total,
          transferred: 0,
          status: "active",
          error: null,
          cancelling: false,
          startedAt: Date.now(),
        },
      ],
    }));
  },

  cancel: async (transferId) => {
    set((st) => ({ items: patchItem(st.items, transferId, { cancelling: true }) }));
    try {
      await transferCancel(transferId);
    } catch (e) {
      // 未知 id（已收尾被自清）：把过渡态回滚，交由用户看到最终状态
      set((st) => ({ items: patchItem(st.items, transferId, { cancelling: false }) }));
      throw e;
    }
  },

  retry: async (transferId) => {
    const item = get().items.find((it) => it.transferId === transferId);
    if (!item) return;
    if (item.status !== "failed" && item.status !== "cancelled") return;
    set((st) => ({ items: st.items.filter((it) => it.transferId !== transferId) }));
    if (item.kind === "download") {
      await get().startDownload(item.rustId, item.remotePath, item.localPath);
    } else {
      await get().startUpload(item.rustId, item.localPath, parentOf(item.remotePath));
    }
  },

  dismiss: (transferId) =>
    set((st) => ({ items: st.items.filter((it) => it.transferId !== transferId) })),

  onBegin: (p) => {
    // 命令回执已建 → 忽略；命令回执未到（事件竞态）→ 占位（total 0 待 progress 校正）
    const existing = get().items.find((it) => it.transferId === p.transfer_id);
    if (existing) return;
    set((st) => ({
      items: [
        ...st.items,
        {
          transferId: p.transfer_id,
          kind: p.kind,
          remotePath: p.remote_path,
          localPath: p.local_path,
          rustId: "",
          total: p.total,
          transferred: 0,
          status: "active",
          error: null,
          cancelling: false,
          startedAt: Date.now(),
        },
      ],
    }));
  },

  onProgress: (p) => {
    set((st) => ({
      items: patchItem(st.items, p.transfer_id, { transferred: p.transferred, total: p.total }),
    }));
  },

  onEnd: (p) => {
    set((st) => ({
      items: patchItem(st.items, p.transfer_id, {
        status: p.status,
        error: p.status === "failed" ? p.message || null : null,
        cancelling: false,
      }),
    }));
  },
}));

/** 队列展示辅助：活动条目在前，其后 done/cancelled，failed 最后（操作入口常驻）。 */
export function sortQueueItems(items: TransferItem[]): TransferItem[] {
  const rank = (it: TransferItem) =>
    it.status === "active" ? 0 : it.status === "failed" ? 2 : 1;
  return [...items].sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
}

export { fileNameOf, parentOf };
