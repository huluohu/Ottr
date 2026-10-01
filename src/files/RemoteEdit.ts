// 远端文件本地编辑链（Phase 2 Task 3，B10 上半）：Tauri 命令契约 + 轮询驱动器。
//
// 职责切分（task-3-report §选型）：「文件 watcher」用**前端轮询**（2s 一次
// remote_edit_poll）而非 notify crate——防抖/冲突/回传的状态机已整体收口在
// Rust 命令域（commands/remote_edit.rs：锁不跨 await、临时副本与远端快照
// 单表持有），前端轮询只是驱动器；为省一个 2s 空转 invoke 引入 notify 原生
// watcher 线程 + 事件桥，复杂度不成比例。
//
// 模块级单例：FilePanel 随「终端 | 文件」视图切换卸载/重挂，编辑会话必须
// 跨挂载存活（临时副本与编辑表归 Rust 管，这里只负责轮询的起停与回调分发）。
import { invoke } from "@tauri-apps/api/core";

/** remote_edit_open 回执（Rust EditOpened 同构）。 */
export interface EditOpened {
  local_path: string;
}

/** remote_edit_poll / remote_edit_save 结果（Rust EditPollStatus 同构）。 */
export interface EditPollStatus {
  status: "quiet" | "saved" | "conflict" | "gone";
}

export function remoteEditOpen(id: string, remote: string): Promise<EditOpened> {
  return invoke("remote_edit_open", { id, remote });
}

export function remoteEditSave(id: string, remote: string, force: boolean): Promise<EditPollStatus> {
  return invoke("remote_edit_save", { id, remote, force });
}

export function remoteEditClose(id: string, remote: string): Promise<boolean> {
  return invoke("remote_edit_close", { id, remote });
}

/** 轮询间隔：编辑器保存频率下、可感知延迟上的折中（Rust 侧另有二轮防抖）。 */
export const EDIT_POLL_MS = 2000;

export interface EditCallbacks {
  /** 自动回传成功（静默保存的反馈面）。 */
  onSaved?: (id: string, remote: string) => void;
  /** 回传前冲突（远端已被第三方改动）：UI 应弹「覆盖？」对话框。 */
  onConflict?: (id: string, remote: string) => void;
}

type Listener = () => void;

class RemoteEditManager {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private inflight = new Set<string>();
  private listeners = new Set<Listener>();
  /** FilePanel 按会话安装的回调（单面板消费，重装即替换）。 */
  callbacks: EditCallbacks = {};

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private key(id: string, remote: string): string {
    return `${id}\n${remote}`;
  }

  isActive(id: string, remote: string): boolean {
    return this.timers.has(this.key(id, remote));
  }

  /** 某会话当前在编辑的远端路径（FilePanel 菜单「停止编辑」的判定面）。 */
  activeRemotes(id: string): string[] {
    const out: string[] = [];
    for (const k of this.timers.keys()) {
      const nl = k.indexOf("\n");
      if (k.slice(0, nl) === id) out.push(k.slice(nl + 1));
    }
    return out;
  }

  /** 右键「编辑」：Rust 下载+落临时副本（成功才轮询）→ 起 2s 轮询。 */
  async open(id: string, remote: string): Promise<EditOpened> {
    const opened = await remoteEditOpen(id, remote);
    this.startPolling(id, remote);
    this.notify();
    return opened;
  }

  private startPolling(id: string, remote: string): void {
    const key = this.key(id, remote);
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setInterval(() => void this.pollOnce(id, remote), EDIT_POLL_MS),
    );
  }

  private stopPolling(id: string, remote: string): void {
    const key = this.key(id, remote);
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(key);
    }
  }

  private async pollOnce(id: string, remote: string): Promise<void> {
    const key = this.key(id, remote);
    if (this.inflight.has(key)) return; // 慢链路防重入
    this.inflight.add(key);
    try {
      const st = await invoke<EditPollStatus>("remote_edit_poll", { id, remote });
      if (st.status === "gone") {
        // 会话已被 Rust 侧清理（关闭/断连/临时件被删）：停轮询即可
        this.stopPolling(id, remote);
        this.notify();
        return;
      }
      if (st.status === "saved") this.callbacks.onSaved?.(id, remote);
      if (st.status === "conflict") this.callbacks.onConflict?.(id, remote);
    } catch {
      // 单次 poll 失败（瞬时抖动）下轮重试；会话真没了 Rust 会返 gone 自清
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 「停止编辑」：停轮询 + Rust 清理临时副本与表项（幂等）。 */
  async close(id: string, remote: string): Promise<void> {
    this.stopPolling(id, remote);
    this.notify();
    try {
      await remoteEditClose(id, remote);
    } catch {
      // 会话已消失：幂等收尾
    }
    this.notify();
  }

  /** 冲突「覆盖远端」裁定。 */
  overwrite(id: string, remote: string): Promise<EditPollStatus> {
    return remoteEditSave(id, remote, true);
  }

  /** 冲突「保留本地」裁定：Rust 记账后轮询不再重弹同一冲突。 */
  keepLocal(id: string, remote: string): Promise<void> {
    return invoke("remote_edit_dismiss", { id, remote });
  }

  /** 测试隔离：清计时器/订阅/回调（真实清理归 Rust 侧，无需 invoke）。 */
  resetForTests(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.inflight.clear();
    this.listeners.clear();
    this.callbacks = {};
  }
}

export const remoteEdits = new RemoteEditManager();
