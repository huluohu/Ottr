// FilePanel（Task 10，A5）：双栏文件管理器（本地/远端）。
//
// 入口（布局语言裁定）：主区标签行右端「终端 | 文件」视图切换按钮（App.tsx），
// 文件视图下终端以 visibility 隐藏常驻（xterm 缓冲不丢，同分屏 pane 惯例）。
//
// 职责：
//   * 左栏本地（导航 + 上传拖源）、右栏远端（SFTP：浏览/mkdir/rename/删除/chmod，
//     操作面走 SFTP 而非 exec——裁定见 ottr-transfer ops 模块文档）；
//   * 路径栏可编辑（Enter 跳转）+ 上级按钮；双击目录进入、双击远端文件下载；
//   * 下载降级（MVP）：拖出到 Finder 不可行 → 「下载到下载目录」+ 提示；
//   * 拖拽上传：Tauri webview onDragDropEvent 拿本地路径，落点命中远端栏上传
//     （目录跳过并提示；坐标按 devicePixelRatio 折算逻辑像素）；
//   * 传输队列（TransferQueue）常驻底部，事件驱动（events.ts）。
//
// 会话耦合：未连接（rustId 空）显示提示；会话切换时两栏重置到各自 home。
import { useCallback, useEffect, useRef, useState } from "react";
import { useEscClose } from "../ui/useEscClose";
import { useModalStore } from "../ui/modalStore";
import { useTranslation } from "react-i18next";
import type { Session } from "../session/SessionStore";
import {
  fileNameOf,
  joinLocalPath,
  formatBytes,
  formatMode,
  joinRemote,
  localCopy,
  localHome,
  localList,
  localMkdir,
  localRemove,
  openLocalFile,
  parentOf,
  sftpChmod,
  sftpList,
  sftpMkdir,
  sftpMkdirAll,
  sftpRealpath,
  sftpRemove,
  sftpRename,
  type DirEntry,
  type LocalEntry,
} from "./api";
import { TransferQueue } from "./TransferQueue";
import { uploadLocalTree } from "./uploadTree";
import { remoteEdits } from "./RemoteEdit";
import { useTransferStore, type TransferStatus } from "./TransferStore";

type Side = "local" | "remote";

// --- 排序（feat/file-panel-enhancements）：名称/大小/修改时间，目录恒在前 ---
export type SortKey = "name" | "size" | "mtime";
export interface SortSpec {
  key: SortKey;
  asc: boolean;
}

/** 排序纯函数：目录恒在前（升降序都不打散），其余按 key 比较；localeCompare
 * 兼顾中文名。不变输入数组。 */
export function sortFileEntries<
  T extends { name: string; is_dir: boolean; size: number; mtime: number },
>(entries: T[], sort: SortSpec): T[] {
  const byKey = (a: T, b: T): number => {
    switch (sort.key) {
      case "size":
        return a.size - b.size;
      case "mtime":
        return a.mtime - b.mtime;
      default:
        return a.name.localeCompare(b.name);
    }
  };
  return [...entries].sort(
    (a, b) => Number(b.is_dir) - Number(a.is_dir) || (sort.asc ? byKey(a, b) : -byKey(a, b)),
  );
}

// --- 目录记忆（2026-10-19 用户需求）：per-host localStorage 持久化上次浏览
// 目录——面板重开/会话重连恢复上次位置；纯函数 + try/catch（localStorage
// 不可用/损坏 JSON 时静默退化为无记忆，不阻塞面板）。
const CWD_MEMORY_KEY = "ottr.files.cwdMemory";

type SavedCwd = { local?: string; remote?: string };

function loadSavedCwd(hostId: number): SavedCwd {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(CWD_MEMORY_KEY) ?? "{}");
    const entry = (all as Record<string, SavedCwd>)[String(hostId)];
    return entry && typeof entry === "object" ? entry : {};
  } catch {
    return {};
  }
}

function saveSavedCwd(hostId: number, side: "local" | "remote", path: string): void {
  try {
    const all: Record<string, SavedCwd> = JSON.parse(
      localStorage.getItem(CWD_MEMORY_KEY) ?? "{}",
    );
    all[String(hostId)] = { ...all[String(hostId)], [side]: path };
    localStorage.setItem(CWD_MEMORY_KEY, JSON.stringify(all));
  } catch {
    // 持久化失败不阻塞浏览
  }
}

function clearSavedCwd(hostId: number, side: "local" | "remote"): void {
  try {
    const all: Record<string, SavedCwd> = JSON.parse(
      localStorage.getItem(CWD_MEMORY_KEY) ?? "{}",
    );
    const entry = all[String(hostId)];
    if (entry) delete entry[side];
    localStorage.setItem(CWD_MEMORY_KEY, JSON.stringify(all));
  } catch {
    // 清理失败无碍（下次加载失败还会再清）
  }
}

interface PaneState {
  path: string;
  entries: (DirEntry & { is_dir: boolean })[] | (LocalEntry & { is_dir: boolean })[];
  error: string | null;
  loading: boolean;
  /** 多选（2026-10-19 用户需求）：本栏选中的条目名集合；Ctrl/⌘ 点选切换、
   *  Shift 范围选、普通点击单选。跨栏各自独立。 */
  selected: ReadonlySet<string>;
}

function emptyPane(path: string): PaneState {
  return { path, entries: [], error: null, loading: false, selected: new Set() };
}

/** 拖拽事件载荷（@tauri-apps/api/webview onDragDropEvent；宽松类型）。 */
interface DragPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position: { x: number; y: number };
}

interface DialogState {
  kind: "mkdir" | "rename" | "chmod" | "delete";
  side: Side;
  target: DirEntry | null;
}

export function FilePanel({ session }: { session: Session }) {
  const { t } = useTranslation();
  const rustId = session.rustId;
  const [remote, setRemote] = useState<PaneState>(emptyPane(""));
  const [local, setLocal] = useState<PaneState>(emptyPane(""));
  const [focus, setFocus] = useState<Side>("remote");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 右键菜单 Esc 关闭（2026-10-09 断点清偿：ctx-overlay 只有点外/再右键，无键盘路径）。
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  // 文件操作小对话框接入全局弹窗唯一槽（2026-10-14 用户裁定）：开启即认领
  // "filesDialog" 槽；被其他弹窗顶掉 = 本框销毁；面板卸载时如仍持槽则释放。
  const dialogOwned = useModalStore((s) => s.active === "filesDialog");
  const openDialog = (d: DialogState) => {
    setDialog(d);
    useModalStore.getState().open("filesDialog");
  };
  const closeDialog = () => {
    setDialog(null);
    useModalStore.getState().close("filesDialog");
  };
  useEffect(() => {
    if (dialog !== null && !dialogOwned) closeDialog();
  }, [dialog, dialogOwned]);
  useEffect(
    () => () => {
      if (useModalStore.getState().active === "filesDialog") {
        useModalStore.getState().close("filesDialog");
      }
    },
    [],
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<Side | null>(null);
  // 行指针拖拽（2026-10-16 用户反馈：HTML5 DnD 在 Tauri webview 里松手无效——
  // 原生文件拖接管后 drag 事件链不可靠，上一版只在 jsdom mock 里验证过）。
  // 改 Pointer Events 自管：按下记录 → 移动超阈值激活 → 浮标跟随 + hit-test
  // 高亮 → 松手命中对侧栏即传输。引擎无关、jsdom 可测真实逻辑。
  const rowDragRef = useRef<{
    side: Side;
    name: string;
    isDir: boolean;
    /** 拖起时按选中集合算好的传输项数（浮标展示 + 多选拖拽判定）。 */
    count: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const [rowDragView, setRowDragView] = useState<{
    side: Side;
    name: string;
    isDir: boolean;
    /** 多选拖拽时的项数（>1 时浮标显示「N 项」）。 */
    count?: number;
    x: number;
    y: number;
  } | null>(null);
  // 每栏排序（feat/file-panel-enhancements）：默认名称升序；表头点击切换。
  const [sorts, setSorts] = useState<Record<Side, SortSpec>>({
    local: { key: "name", asc: true },
    remote: { key: "name", asc: true },
  });
  /** 本会话在编辑中的远端路径（RemoteEditManager 订阅同步）。 */
  const [editing, setEditing] = useState<string[]>([]);
  /** 冲突待裁定的远端路径（非空 = 「远端已变更，覆盖？」对话框开着）。 */
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startDownload = useTransferStore((s) => s.startDownload);
  const startUpload = useTransferStore((s) => s.startUpload);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  // --- 远端编辑（Phase 2 Task 3）：编辑态订阅 + 冲突回调接线 -------------------
  // 管理器是模块级单例：本面板只镜像「本会话在编辑哪些路径」供菜单渲染；
  // 轮询与临时副本归 Rust 侧（commands/remote_edit.rs）+ 管理器持有。
  useEffect(() => {
    const sync = () => setEditing(remoteEdits.activeRemotes(rustId ?? ""));
    sync();
    return remoteEdits.subscribe(sync);
  }, [rustId]);

  useEffect(() => {
    remoteEdits.callbacks = {
      onSaved: (id, path) => {
        if (id === rustId) showNotice(t("files.editSaved", { name: fileNameOf(path) }));
      },
      onConflict: (id, path) => {
        if (id === rustId) setConflictPath(path);
      },
      onRemoteGone: (id, path) => {
        if (id === rustId) showNotice(t("files.remoteGone", { name: fileNameOf(path) }));
      },
    };
    return () => {
      remoteEdits.callbacks = {};
    };
  }, [rustId, showNotice, t]);

  async function startEditing(path: string) {
    if (!rustId) return;
    try {
      await remoteEdits.open(rustId, path);
      showNotice(t("files.editOpened", { name: fileNameOf(path) }));
    } catch (e) {
      const msg = String(e);
      // 超限拒绝（M-1，Rust MAX_EDIT_BYTES=10MB）单列提示，其余走通用失败
      if (msg.includes("too large")) {
        showNotice(t("files.editTooLarge", { name: fileNameOf(path) }));
      } else if (msg.includes("binary_file")) {
        // BL-506 二进制嗅探（Rust edit_open 首块 NUL 探针）：令牌映射专用提示，
        // 提示+放弃（不做强制编辑路径）
        showNotice(t("files.editBinary", { name: fileNameOf(path) }));
      } else {
        showNotice(t("files.editFailed", { message: msg }));
      }
    }
  }

  async function stopEditing(path: string) {
    if (!rustId) return;
    await remoteEdits.close(rustId, path);
    showNotice(t("files.editClosed", { name: fileNameOf(path) }));
  }

  /** 冲突裁定：「覆盖远端」= 强制回传并刷新远端列；「保留本地」= Rust 记账。 */
  async function resolveConflict(overwrite: boolean) {
    if (!rustId || !conflictPath) return;
    const path = conflictPath;
    setConflictPath(null);
    if (!overwrite) {
      await remoteEdits.keepLocal(rustId, path);
      return;
    }
    try {
      await remoteEdits.overwrite(rustId, path);
      showNotice(t("files.editOverwritten", { name: fileNameOf(path) }));
      void loadRemote(remote.path);
    } catch (e) {
      showNotice(t("files.editFailed", { message: String(e) }));
    }
  }

  // --- 列目录 ----------------------------------------------------------------

  // 返回是否加载成功（目录记忆初载的回退判定面；其余调用方 void 忽略）。
  const loadLocal = useCallback(async (path: string): Promise<boolean> => {
    setLocal((p) => ({ ...p, path, loading: true, error: null, selected: new Set() }));
    try {
      const list = await localList(path);
      const entries = Array.isArray(list) ? list : [];
      setLocal((p) => ({ ...p, entries, loading: false }));
      return true;
    } catch (e) {
      setLocal((p) => ({ ...p, loading: false, error: String(e) }));
      return false;
    }
  }, []);

  const loadRemote = useCallback(
    async (path: string): Promise<boolean> => {
      if (!rustId) return false;
      setRemote((p) => ({ ...p, path, loading: true, error: null, selected: new Set() }));
      try {
        const list = await sftpListFor(rustId, path);
        const entries = Array.isArray(list) ? list : [];
        setRemote((p) => ({ ...p, entries, loading: false }));
        return true;
      } catch (e) {
        setRemote((p) => ({ ...p, loading: false, error: String(e) }));
        return false;
      }
    },
    [rustId],
  );

  // 初载：本地 = home；远端 = realpath(".")（= home）。**目录记忆（2026-10-19
  // 用户需求）**：按主机持久化上次浏览目录（localStorage，键 = hostId）——
  // 面板重开/会话重连恢复上次位置；保存的路径已不存在（远端被删/本地移动）
  // 时回退 home 并清掉该侧记忆，防永久坏状态。会话切换 = 换主机时各用各的
  // 记忆，互不串扰。
  useEffect(() => {
    void (async () => {
      const saved = loadSavedCwd(session.hostId).local;
      if (saved && (await loadLocal(saved))) return;
      // 记忆路径已失效（或无记忆）：清掉该侧记忆，回 home
      clearSavedCwd(session.hostId, "local");
      if (!(await loadLocal(await localHome()))) {
        setLocal((p) => ({ ...p, error: "cannot resolve home" }));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初载一次；hostId 变化 = 组件随会话重挂
  }, []);

  useEffect(() => {
    if (!rustId) {
      setRemote(emptyPane(""));
      return;
    }
    void (async () => {
      const saved = loadSavedCwd(session.hostId).remote;
      if (saved && (await loadRemote(saved))) return;
      clearSavedCwd(session.hostId, "remote");
      const home = await sftpRealpath(rustId, ".");
      void loadRemote(home);
    })();
  }, [rustId, loadRemote]);

  // 目录记忆写入：浏览成功（path 变化即成功加载过的结果）即持久化
  useEffect(() => {
    if (local.path) saveSavedCwd(session.hostId, "local", local.path);
  }, [session.hostId, local.path]);
  useEffect(() => {
    if (remote.path) saveSavedCwd(session.hostId, "remote", remote.path);
  }, [session.hostId, remote.path]);

  // 传输完成 → 对应侧自动刷新（上传=远端，下载=本地）：用户不用手动点刷新
  // 才能看到传输结果。用状态迁移判定（前值非 done、现值 done）——初挂载时
  // store 里可能残留旧会话的 done 条目，prev===undefined 不触发。
  const transfers = useTransferStore((s) => s.items);
  const transferStatusRef = useRef<Map<string, TransferStatus>>(new Map());
  useEffect(() => {
    let dirty = false;
    const seen = new Set<string>();
    for (const it of transfers) {
      seen.add(it.transferId);
      const prev = transferStatusRef.current.get(it.transferId);
      if (prev !== undefined && prev !== "done" && it.status === "done") {
        if (it.kind === "upload") void loadRemote(remote.path);
        else void loadLocal(local.path);
      }
      if (prev !== it.status) {
        transferStatusRef.current.set(it.transferId, it.status);
        dirty = true;
      }
    }
    // 收尾条目 6s 后自动销毁（TransferStore），水位表同步裁剪防无界增长。
    if (dirty) {
      for (const id of [...transferStatusRef.current.keys()]) {
        if (!seen.has(id)) transferStatusRef.current.delete(id);
      }
    }
  }, [transfers, loadRemote, loadLocal, remote.path, local.path]);

  // --- 拖拽（Tauri onDragDropEvent）：OS 文件落远端栏=上传、落本地栏=复制进
  // 当前目录；跨面板内部拖拽走行 dragstart（见 renderPane onDrop）。 ----------
  useEffect(() => {
    if (!rustId) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const off = await getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload as unknown as DragPayload;
          if (p.type === "leave") {
            setDropTarget(null);
            return;
          }
          // 物理像素 → 逻辑像素（elementFromPoint 用 CSS px）
          const x = p.position.x / (window.devicePixelRatio || 1);
          const y = p.position.y / (window.devicePixelRatio || 1);
          const hit = document
            .elementFromPoint(x, y)
            ?.closest("[data-file-drop]")
            ?.getAttribute("data-file-drop");
          const target: Side | null = hit === "remote" ? "remote" : hit === "local" ? "local" : null;
          if (p.type === "drop") {
            setDropTarget(null);
            if (target !== null) void handleDrop(p.paths ?? [], target);
          } else {
            setDropTarget(target);
          }
        });
        if (cancelled) off();
        else unlisten = off;
      } catch {
        // 非 Tauri 环境（组件测试/jsdom）：拖拽能力缺席即缺席，不炸面板
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rustId, remote.path, local.path]);

  async function handleDrop(paths: string[], target: Side) {
    if (!rustId || paths.length === 0) return;
    let queued = 0;
    let skippedDirs = 0;
    for (const p of paths) {
      // 目录判定：查父目录列表判定 is_dir（一次 invoke 足够）。
      let isDir = false;
      try {
        const siblings = await localList(parentOf(p));
        const name = fileNameOf(p);
        isDir = siblings.find((s) => s.name === name)?.is_dir === true;
      } catch {
        // 判定不了按文件尝试（Rust 侧打开失败会进队列 failed 态）
      }
      if (isDir) {
        if (target === "remote") {
          // 递归上传（2026-10-19）：建远端目录树 + 逐文件入队
          const r = await uploadLocalTree(p, remote.path, {
            list: localList,
            mkdir: (rp) => sftpMkdirAll(rustId, rp),
            uploadFile: (f, d) => startUpload(rustId, f, d),
            joinLocal: joinLocalPath,
            joinRemote,
          });
          queued += r.files;
          skippedDirs += r.skipped;
        } else {
          skippedDirs++; // 递归下载不在本期（远端侧遍历另行排期）
        }
        continue;
      }
      if (target === "remote") {
        queued++;
        void startUpload(rustId, p, remote.path).catch((e) =>
          showNotice(t("files.uploadFailed", { message: String(e) })),
        );
      } else {
        try {
          await localCopy(p, local.path);
          queued++;
        } catch (e) {
          showNotice(t("files.opFailed", { message: String(e) }));
        }
      }
    }
    if (skippedDirs > 0) {
      showNotice(t("files.dropDirsSkipped", { count: skippedDirs }));
    } else if (queued > 0) {
      showNotice(
        target === "remote"
          ? t("files.dropQueued", { count: queued })
          : t("files.dropLocalCopied", { count: queued }),
      );
    }
  }

  // --- 行指针拖拽：传输分发（每渲染刷新 ref，window 监听拿最新闭包）--------
  const dropRowRef = useRef<(d: { side: Side; name: string; isDir: boolean }, target: Side) => void>(
    () => {},
  );
  dropRowRef.current = (d, target) => {
    // 多选拖拽（2026-10-19 用户反馈「多选拖拽只传了一个」）：拖起的行若在
    // 当前选中集合内且集合非空 → 传输整个集合；否则只传该行。
    const sourceState = d.side === "local" ? local : remote;
    const dragged = sourceState.entries.filter((e) => e.name === d.name);
    const picked = sourceState.selected.has(d.name)
      ? sourceState.entries.filter((e) => sourceState.selected.has(e.name))
      : dragged;
    const items = picked.length > 0 ? picked : dragged;
    if (!rustId) return;

    if (d.side === "local" && target === "remote") {
      void uploadLocalSelection(items);
      return;
    }
    if (d.side === "remote" && target === "local") {
      const files = items.filter((e) => !e.is_dir);
      const skipped = items.length - files.length;
      for (const e of files) {
        void startDownload(
          rustId,
          joinRemote(remote.path, e.name),
          joinLocalPath(local.path, e.name),
        ).catch((err) => showNotice(t("files.downloadFailed", { message: String(err) })));
      }
      if (files.length === 1 && skipped === 0) {
        showNotice(t("files.menu.downloadToLocal", { name: files[0].name }));
      } else if (files.length > 1) {
        showNotice(t("files.dropDownloadQueued", { count: files.length }));
      } else if (skipped > 0) {
        showNotice(t("files.dropDirsSkipped", { count: skipped }));
      }
    }
  };

  useEffect(() => {
    const DRAG_THRESHOLD = 6;
    const hitSide = (x: number, y: number): Side | null => {
      const el = document.elementFromPoint(x, y);
      const hit = el?.closest("[data-file-drop]")?.getAttribute("data-file-drop");
      return hit === "local" || hit === "remote" ? (hit as Side) : null;
    };
    const onMove = (ev: PointerEvent) => {
      const d = rowDragRef.current;
      if (!d) return;
      if (!d.active) {
        if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < DRAG_THRESHOLD) return;
        d.active = true;
      }
      setRowDragView({
        side: d.side,
        name: d.name,
        isDir: d.isDir,
        count: d.count,
        x: ev.clientX,
        y: ev.clientY,
      });
      const target = hitSide(ev.clientX, ev.clientY);
      setDropTarget(target !== null && target !== d.side ? target : null);
    };
    const finish = (ev: PointerEvent) => {
      const d = rowDragRef.current;
      rowDragRef.current = null;
      setRowDragView(null);
      setDropTarget(null);
      if (!d?.active) return; // 未过阈值 = 普通点击，交给 onClick
      const target = hitSide(ev.clientX, ev.clientY);
      if (target === null || target === d.side) return;
      dropRowRef.current({ side: d.side, name: d.name, isDir: d.isDir }, target);
    };
    const onCancel = () => {
      rowDragRef.current = null;
      setRowDragView(null);
      setDropTarget(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  // --- 操作（全部作用于 focus 侧；本地侧仅刷新——本地写操作不进 MVP） ------------

  const pane = focus === "local" ? local : remote;
  // 单选面操作（重命名/权限/删除/编辑）仅在恰好选中一项时可用；
  // 批量面（下载/上传）走 selectedNames / selectedEntries。
  const selectedEntries = pane.entries.filter((e) => pane.selected.has(e.name));
  const selectedEntry = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const selectedRemotePath =
    focus === "remote" && selectedEntry ? joinRemote(remote.path, selectedEntry.name) : null;

  // --- 多选（2026-10-19）：普通点击单选 / Ctrl·⌘ 切换 / Shift 范围 ----------
  // anchor 记录上次单选锚点（范围选起点），按栏各存一个。
  const selectAnchor = useRef<{ local: string | null; remote: string | null }>({
    local: null,
    remote: null,
  });
  const clearSelection = (side: Side) => {
    const cur = side === "local" ? local : remote;
    if (cur.selected.size === 0) return;
    selectAnchor.current[side] = null;
    applySelection(side, new Set());
  };
  const applySelection = (side: Side, next: ReadonlySet<string>) => {
    if (side === "local") setLocal((p) => ({ ...p, selected: next }));
    else setRemote((p) => ({ ...p, selected: next }));
  };
  const toggleSelect = (side: Side, name: string) => {
    const cur = side === "local" ? local : remote;
    const next = new Set(cur.selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    selectAnchor.current[side] = name;
    applySelection(side, next);
  };
  const selectRow = (
    side: Side,
    name: string,
    ev: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean },
  ) => {
    const cur = side === "local" ? local : remote;
    if (ev.shiftKey && selectAnchor.current[side]) {
      const ordered = sortFileEntries(cur.entries, sorts[side]).map((e) => e.name);
      const a = ordered.indexOf(selectAnchor.current[side] as string);
      const b = ordered.indexOf(name);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        applySelection(side, new Set(ordered.slice(lo, hi + 1)));
        return;
      }
    }
    if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(cur.selected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      selectAnchor.current[side] = name;
      applySelection(side, next);
      return;
    }
    selectAnchor.current[side] = name;
    applySelection(side, new Set([name]));
  };

  /** 批量下载（远端选中项 → 本地；目录跳过并提示）。 */
  async function downloadSelected() {
    if (!rustId) return;
    const files = selectedEntries.filter((e) => !e.is_dir);
    const skipped = selectedEntries.length - files.length;
    for (const e of files) {
      void startDownload(rustId, joinRemote(remote.path, e.name)).catch((err) =>
        showNotice(t("files.downloadFailed", { message: String(err) })),
      );
    }
    if (files.length === 1) {
      showNotice(t("files.downloadToDownloads", { name: files[0].name }));
    } else if (files.length > 1) {
      showNotice(t("files.dropDownloadQueued", { count: files.length }));
    }
    if (skipped > 0 && files.length === 0) {
      showNotice(t("files.dropDirsSkipped", { count: skipped }));
    }
  }

  /** 批量上传（本地选中项 → 远端当前目录）：文件直接入队；目录递归建远端
   *  目录树后逐文件入队（2026-10-19 用户需求）。统计进提示。 */
  async function uploadLocalSelection(entries: Array<{ name: string; is_dir: boolean }>) {
    if (!rustId) return;
    let files = 0;
    let dirs = 0;
    let skipped = 0;
    for (const e of entries) {
      const abs = joinLocalPath(local.path, e.name);
      if (e.is_dir) {
        try {
          const r = await uploadLocalTree(abs, remote.path, {
            list: localList,
            mkdir: (p) => sftpMkdirAll(rustId, p),
            uploadFile: (f, d) => startUpload(rustId, f, d),
            joinLocal: joinLocalPath,
            joinRemote,
          });
          files += r.files;
          dirs += r.dirs;
          skipped += r.skipped;
        } catch (err) {
          skipped++;
          showNotice(t("files.uploadFailed", { message: String(err) }));
        }
      } else {
        await startUpload(rustId, abs, remote.path);
        files++;
      }
    }
    if (files > 0) {
      showNotice(t("files.dropQueued", { count: files }));
    }
    if (skipped > 0) {
      showNotice(t("files.dropDirsSkipped", { count: skipped }));
    }
    void dirs;
  }

  function navigate(side: Side, path: string) {
    if (side === "local") void loadLocal(path);
    else void loadRemote(path);
  }

  function goUp(side: Side) {
    navigate(side, parentOf((side === "local" ? local : remote).path));
  }

  function openEntry(side: Side, e: DirEntry | LocalEntry) {
    const path = joinRemote((side === "local" ? local : remote).path, e.name);
    if (e.is_dir) {
      navigate(side, path);
    } else if (side === "remote") {
      // 下载降级（MVP 裁定）：不拖出 Finder，落下载目录 + 提示
      if (!rustId) return;
      void startDownload(rustId, path)
        .then(() => showNotice(t("files.downloadToDownloads", { name: e.name })))
        .catch((err) => showNotice(t("files.downloadFailed", { message: String(err) })));
    }
  }

  async function applyDialog(value: string) {
    if (!dialog) return;
    const { kind, side, target } = dialog;
    if (side === "local") {
      // 本地写操作（feat/file-panel-enhancements）：mkdir / 删除。rename/chmod
      // 本地暂无命令面，菜单不出现该入口；此分支为防御性兜底。
      try {
        if (kind === "mkdir") {
          await localMkdir(joinLocalPath(local.path, value));
        } else if (kind === "delete" && target) {
          await localRemove(joinLocalPath(local.path, target.name), target.is_dir);
        } else {
          throw new Error(`unsupported local op: ${kind}`);
        }
        closeDialog();
        void loadLocal(local.path);
      } catch (e) {
        showNotice(t("files.opFailed", { message: String(e) }));
      }
      return;
    }
    const path = joinRemote(remote.path, target?.name ?? "");
    try {
      if (kind === "mkdir") {
        await sftpMkdir(rustId!, joinRemote(remote.path, value));
      } else if (kind === "rename" && target) {
        await sftpRename(rustId!, path, joinRemote(remote.path, value));
      } else if (kind === "chmod" && target) {
        const mode = parseInt(value, 8);
        if (!Number.isFinite(mode) || mode < 0 || mode > 0o777) {
          throw new Error(t("files.errOctalMode"));
        }
        await sftpChmod(rustId!, path, mode);
      } else if (kind === "delete" && target) {
        await sftpRemove(rustId!, path, target.is_dir);
      }
      closeDialog();
      void loadRemote(remote.path);
    } catch (e) {
      showNotice(t("files.opFailed", { message: String(e) }));
    }
  }

  /** 表头点击排序：同 key 翻转方向，新 key 默认升序（目录恒在前）。 */
  function toggleSort(side: Side, key: SortKey) {
    setSorts((prev) => {
      const cur = prev[side];
      return { ...prev, [side]: cur.key === key ? { key, asc: !cur.asc } : { key, asc: true } };
    });
  }

  const menuItems: { label: string; danger?: boolean; action: () => void }[] =
    focus === "remote" && rustId
      ? [
          { label: t("files.menu.refresh"), action: () => loadRemote(remote.path) },
          {
            label: t("files.menu.mkdir"),
            action: () => openDialog({ kind: "mkdir", side: "remote", target: null }),
          },
          ...(selectedEntry
            ? [
                {
                  label: t("files.menu.rename", { name: selectedEntry.name }),
                  action: () =>
                    openDialog({ kind: "rename", side: "remote", target: selectedEntry }),
                },
                {
                  label: t("files.menu.chmod", { name: selectedEntry.name }),
                  action: () => openDialog({ kind: "chmod", side: "remote", target: selectedEntry }),
                },
                {
                  label: t("files.menu.delete", { name: selectedEntry.name }),
                  danger: true,
                  action: () =>
                    openDialog({ kind: "delete", side: "remote", target: selectedEntry }),
                },
              ]
            : []),
          ...(selectedEntry && !selectedEntry.is_dir
            ? [
                // 编辑入口按会话分流（2026-10-20）：本地会话的右栏就是本机文件，
                // 「打开」直接交给系统默认程序（不走 SFTP 临时文件回传）；
                // SSH 走远端编辑（SFTP 读写原语）；FTP/FTPS 无此能力按协议隐藏。
                ...(session.kind === "local"
                  ? [
                      {
                        label: t("files.menu.openWith", { name: selectedEntry.name }),
                        action: () => void openLocalFile(selectedRemotePath ?? ""),
                      },
                    ]
                  : session.protocol === "ssh"
                    ? [
                        selectedRemotePath && editing.includes(selectedRemotePath)
                          ? {
                              label: t("files.menu.stopEdit", { name: selectedEntry.name }),
                              action: () => void stopEditing(selectedRemotePath),
                            }
                          : {
                              label: t("files.menu.edit", { name: selectedEntry.name }),
                              action: () => void startEditing(selectedRemotePath ?? ""),
                            },
                      ]
                    : []),
                ...(selectedEntry && !selectedEntry.is_dir
                  ? [
                      {
                        label: t("files.menu.downloadToLocal", { name: selectedEntry.name }),
                        action: () => {
                          if (!rustId) return;
                          void startDownload(
                            rustId,
                            joinRemote(remote.path, selectedEntry.name),
                            joinLocalPath(local.path, selectedEntry.name),
                          )
                            .then(() =>
                              showNotice(
                                t("files.menu.downloadToLocal", { name: selectedEntry.name }),
                              ),
                            )
                            .catch((err) =>
                              showNotice(
                                t("files.downloadFailed", { message: String(err) }),
                              ),
                            );
                        },
                      },
                      {
                        label: t("files.menu.download", { name: selectedEntry.name }),
                        action: () => openEntry("remote", selectedEntry),
                      },
                    ]
                  : []),
              ]
            : []),
        ]
      : [
          { label: t("files.menu.refresh"), action: () => loadLocal(local.path) },
          {
            label: t("files.menu.mkdir"),
            action: () => openDialog({ kind: "mkdir", side: "local", target: null }),
          },
          ...(selectedEntry
            ? [
                {
                  label: t("files.menu.delete", { name: selectedEntry.name }),
                  danger: true,
                  action: () =>
                    openDialog({ kind: "delete", side: "local", target: selectedEntry }),
                },
              ]
            : []),
          ...(selectedEntry && !selectedEntry.is_dir && rustId
            ? [
                {
                  label: t("files.menu.upload", { name: selectedEntry.name }),
                  action: () => {
                    void startUpload(
                      rustId,
                      joinLocalPath(local.path, selectedEntry.name),
                      remote.path,
                    ).catch((e) =>
                      showNotice(t("files.uploadFailed", { message: String(e) })),
                    );
                  },
                },
              ]
            : []),
        ];

  if (!rustId) {
    return (
      <div className="file-panel" data-testid="file-panel">
        <p className="file-hint" data-testid="file-panel-hint">
          {t("files.notConnected")}
        </p>
      </div>
    );
  }

  const renderPane = (side: Side, state: PaneState) => (
    <section
      className="file-pane"
      data-side={side}
      data-focused={focus === side}
      data-droptarget={dropTarget === side}
      data-file-drop={side}
      aria-label={side === "local" ? t("files.localPane") : t("files.remotePane")}
      onPointerDown={() => setFocus(side)}
      onContextMenu={(ev) => {
        // 空白区右键（2026-10-16 用户反馈：弹了 webview 默认「Reload」）——
        // 行级 handler 已 preventDefault 的不重复接管；此处只兜空白区。
        if (ev.defaultPrevented) return;
        ev.preventDefault();
        setFocus(side);
        const menuW = 220;
        const menuH = 360;
        setMenu({
          x: Math.min(ev.clientX, window.innerWidth - menuW),
          y: Math.min(ev.clientY, window.innerHeight - menuH),
        });
      }}
    >
      {/* pane 标题条（2026-10-10 双栏重设计）：显性 本地/远端 标记——纯路径
          行无法分辨两侧（用户实测混淆）；焦点侧经 data-focused 高亮。 */}
      <div className="file-pane-title" data-testid={`file-title-${side}`}>
        <span className="file-pane-dot" aria-hidden="true" />
        <span className="file-pane-name">
          {side === "local"
            ? t("files.localPane")
            : session.kind === "local"
              ? t("files.localMachinePane")
              : `${t("files.remotePane")} · ${session.hostName}`}
        </span>
      </div>
      <div className="file-pane-path">
        <button
          className="file-up"
          aria-label={t("files.upAria")}
          onClick={() => goUp(side)}
          disabled={!state.path || state.path === "/"}
        >
          ↑
        </button>
        <input
          value={state.path}
          aria-label={side === "local" ? t("files.localPath") : t("files.remotePath")}
          onChange={(e) =>
            side === "local"
              ? setLocal((p) => ({ ...p, path: e.target.value }))
              : setRemote((p) => ({ ...p, path: e.target.value }))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(side, (side === "local" ? local : remote).path);
          }}
        />
        <button
          className="file-go"
          onClick={() => navigate(side, state.path)}
          aria-label={t("files.goAria")}
        >
          {t("files.go")}
        </button>
      </div>
      {/* 排序列头（feat/file-panel-enhancements）：名称/大小/时间可点，同 key
          翻方向，目录恒在前；权限列不参与排序占位对齐。listbox 外置避免
          role 冲突。 */}
      <div className="file-head" data-testid={`file-sort-head-${side}`}>
        <span className="file-icon" aria-hidden="true" />
        {(["name", "size"] as SortKey[]).map((key) => (
          <SortHeaderCell
            key={key}
            sortKey={key}
            side={side}
            label={t(key === "name" ? "files.sort.name" : "files.sort.size")}
            extraClass={key === "size" ? " file-size" : ""}
            sort={sorts[side]}
            onToggle={() => toggleSort(side, key)}
          />
        ))}
        <span className="file-meta file-mode" aria-hidden="true" />
        <SortHeaderCell
          sortKey="mtime"
          side={side}
          label={t("files.sort.mtime")}
          extraClass=" file-mtime"
          sort={sorts[side]}
          onToggle={() => toggleSort(side, "mtime")}
        />
      </div>
      <div
        className="file-list"
        data-testid={`file-list-${side}`}
        role="listbox"
        // 多选语义：aria-multiselectable 与集合选中一致
        aria-multiselectable
        onClick={(ev) => {
          // 点列表空白清除选中（2026-10-19 用户需求）：落在行上的点击不清。
          if ((ev.target as HTMLElement).closest('[role="option"]')) return;
          clearSelection(side);
        }}
      >
        {state.loading && <p className="file-status">{t("common.loading")}</p>}
        {state.error && (
          <p className="file-status file-error" data-testid={`file-error-${side}`}>
            {t("files.listFailed", { message: state.error })}
          </p>
        )}
        {!state.loading &&
          !state.error &&
          sortFileEntries(state.entries, sorts[side]).map((e) => (
            <div
              key={e.name}
              role="option"
              aria-selected={state.selected.has(e.name)}
              className="file-row"
              data-selected={state.selected.has(e.name)}
              tabIndex={0}
              onKeyDown={(ev) => {
                // 键盘可达（2026-10-16 全面评审 frontend-ui-3）：Enter=打开/
                // 下载，空格=选中——此前整个文件列表键盘完全不可达。
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  openEntry(side, e);
                } else if (ev.key === " ") {
                  ev.preventDefault();
                  toggleSelect(side, e.name);
                }
              }}
              onPointerDown={(ev) => {
                // 指针拖拽源（2026-10-16 重写）：仅记录，移动超阈值才成拖拽；
                // 左键之外（右键菜单）不进入拖拽流程。
                if (ev.button !== 0) return;
                const paneSel = side === "local" ? local.selected : remote.selected;
                rowDragRef.current = {
                  side,
                  name: e.name,
                  isDir: e.is_dir,
                  count: paneSel.has(e.name) && paneSel.size > 1 ? paneSel.size : 1,
                  startX: ev.clientX,
                  startY: ev.clientY,
                  active: false,
                };
              }}
              onClick={(ev) => selectRow(side, e.name, ev)}
              onDoubleClick={() => openEntry(side, e)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                setFocus(side);
                const cur = side === "local" ? local : remote;
                if (!cur.selected.has(e.name)) {
                  const only = new Set([e.name]);
                  if (side === "local") setLocal((p) => ({ ...p, selected: only }));
                  else setRemote((p) => ({ ...p, selected: only }));
                }
                // 视口钳位（2026-10-16 全面评审 frontend-ui-2）：窗口右/下边缘
                // 右键时菜单不再被裁出视口。
                const menuW = 220;
                const menuH = 360;
                setMenu({
                  x: Math.min(ev.clientX, window.innerWidth - menuW),
                  y: Math.min(ev.clientY, window.innerHeight - menuH),
                });
              }}
            >
              <span className="file-icon" aria-hidden>
                <FileIcon kind={fileIconKind(e)} />
              </span>
              <span className="file-name" title={e.name}>
                {e.name}
              </span>
              <span className="file-meta file-size">
                {e.is_dir ? "—" : formatBytes(e.size)}
              </span>
              <span className="file-meta file-mode">{formatMode(e.mode)}</span>
              <span className="file-meta file-mtime">
                {e.mtime ? new Date(e.mtime * 1000).toLocaleDateString() : ""}
              </span>
            </div>
          ))}
      </div>
    </section>
  );

  return (
    <div className="file-panel" data-testid="file-panel">
      <div className="file-toolbar">
        {/* 刷新 = 双侧同时（2026-10-16 用户目标「支持刷新列表」——只刷焦点侧
            时另一栏的传输/外部变更不可见）；右键菜单仍保留单侧刷新。 */}
        <button
          data-testid="fb-refresh"
          onClick={() => {
            void loadLocal(local.path);
            void loadRemote(remote.path);
          }}
        >
          {t("files.menu.refresh")}
        </button>
        {focus === "local" && (
          <>
            <button
              data-testid="fb-mkdir-local"
              onClick={() => openDialog({ kind: "mkdir", side: "local", target: null })}
            >
              {t("files.menu.mkdir")}
            </button>
            <button
              data-testid="fb-delete-local"
              disabled={!selectedEntry}
              className="icon-btn danger"
              onClick={() => selectedEntry && openDialog({ kind: "delete", side: "local", target: selectedEntry })}
            >
              {t("common.delete")}
            </button>
            <button
              data-testid="fb-upload"
              disabled={selectedEntries.length === 0}
              onClick={() => void uploadLocalSelection(selectedEntries)}
            >
              {t("files.upload")}
              {selectedEntries.length > 1 ? ` (${selectedEntries.length})` : ""}
            </button>
          </>
        )}
        {focus === "remote" && (
          <>
            <button data-testid="fb-mkdir" onClick={() => openDialog({ kind: "mkdir", side: "remote", target: null })}>
              {t("files.menu.mkdir")}
            </button>
            <button
              disabled={!selectedEntry}
              onClick={() => selectedEntry && openDialog({ kind: "rename", side: "remote", target: selectedEntry })}
            >
              {t("files.rename")}
            </button>
            <button
              disabled={!selectedEntry}
              onClick={() => selectedEntry && openDialog({ kind: "chmod", side: "remote", target: selectedEntry })}
            >
              {t("files.chmod")}
            </button>
            <button
              disabled={!selectedEntry}
              className="icon-btn danger"
              onClick={() => selectedEntry && openDialog({ kind: "delete", side: "remote", target: selectedEntry })}
            >
              {t("common.delete")}
            </button>
            <button
              data-testid="fb-download"
              disabled={!selectedEntries.some((e) => !e.is_dir)}
              onClick={() => void downloadSelected()}
            >
              {t("files.download")}
              {selectedEntries.filter((e) => !e.is_dir).length > 1
                ? ` (${selectedEntries.filter((e) => !e.is_dir).length})`
                : ""}
            </button>
          </>
        )}
        <span className="file-toolbar-hint">{t("files.toolbarHint")}</span>
        {notice && (
          <span className="file-notice" data-testid="file-notice" role="status">
            {notice}
          </span>
        )}
      </div>
      <div className="file-panes">
        {renderPane("local", local)}
        {renderPane("remote", remote)}
      </div>
      <TransferQueue />
      {rowDragView && (
        <div
          className="file-drag-badge"
          data-testid="file-drag-badge"
          style={{ left: rowDragView.x + 14, top: rowDragView.y + 14 }}
          aria-hidden="true"
        >
          <span className="file-icon">
            <FileIcon kind={fileIconKind({ name: rowDragView.name, is_dir: rowDragView.isDir })} />
          </span>
          {rowDragView.name}
          {(rowDragView.count ?? 1) > 1 ? ` （${rowDragView.count} 项）` : ""}
        </div>
      )}
      {menu && (
        <>
          <div className="ctx-overlay" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="ctx-menu" role="menu" style={{ left: menu.x, top: menu.y }} data-testid="file-ctx-menu">
            {menuItems.map((it) => (
              <button
                key={it.label}
                role="menuitem"
                className={`ctx-menu-item${it.danger ? " danger" : ""}`}
                onClick={() => {
                  setMenu(null);
                  it.action();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
      {dialog && dialogOwned && (
        <PanelDialog
          dialog={dialog}
          onClose={() => closeDialog()}
          onConfirm={(v) => void applyDialog(v)}
        />
      )}
      {conflictPath && (
        <div className="overlay" role="presentation" onMouseDown={() => setConflictPath(null)}>
          <div
            className="dialog file-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("files.dlg.conflictTitle")}
            onMouseDown={(e) => e.stopPropagation()}
            data-testid="file-dialog"
          >
            <h2>{t("files.dlg.conflictTitle")}</h2>
            <p>{t("files.dlg.conflictConfirm", { name: fileNameOf(conflictPath) })}</p>
            <div className="form-actions">
              <button data-testid="conflict-keep" onClick={() => void resolveConflict(false)}>
                {t("files.dlg.keepLocal")}
              </button>
              <button
                className="btn-accent"
                data-testid="file-dialog-confirm"
                onClick={() => void resolveConflict(true)}
              >
                {t("files.dlg.conflictOverwrite")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 远端列目录（rustId 非空前提下）。 */
async function sftpListFor(rustId: string, path: string): Promise<DirEntry[]> {
  return sftpList(rustId, path);
}

// ---------------------------------------------------------------------------
// 文件类型图标（2026-10-16 用户反馈：一列「·」分不出文件夹/文件/文本）。
// 按扩展名启发式分五类——不做内容嗅探（SFTP 逐文件读头部太贵），扩展名覆盖
// 日常面足够；未命中回落通用文件。
// ---------------------------------------------------------------------------

export type FileIconKind = "dir" | "text" | "image" | "archive" | "file";

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "conf", "cfg", "ini", "env", "yaml", "yml",
  "toml", "json", "xml", "html", "htm", "css", "scss", "less", "js", "mjs",
  "cjs", "ts", "tsx", "jsx", "py", "rb", "rs", "go", "c", "h", "cpp", "hpp",
  "java", "kt", "swift", "php", "pl", "sql", "sh", "bash", "zsh", "fish",
  "lua", "vim", "service", "socket", "timer", "desktop", "properties",
  "gitignore", "gitconfig", "gitattributes", "dockerfile", "makefile", "lock",
  "csv", "tsv", "plist", "bat", "ps1", "diff", "patch", "srt", "lrc",
  "readme", "license", "contributing", "changelog",
]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "tiff", "tif", "heic", "avif"]);
const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "dmg", "iso", "deb", "rpm", "apk", "jar"]);

/** 条目 → 图标类别（纯函数；dotfile 去前导点再取扩展名，.gitignore/.env 归文本；
 * 无点文件名整个当扩展名候选——README/LICENSE/Makefile 归文本，随机二进制不命中集合回落通用）。 */
export function fileIconKind(entry: { name: string; is_dir: boolean }): FileIconKind {
  if (entry.is_dir) return "dir";
  const base = entry.name.replace(/^\./, "");
  const dot = base.lastIndexOf(".");
  const ext = (dot > 0 ? base.slice(dot + 1) : base).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (TEXT_EXTS.has(ext)) return "text";
  return "file";
}

/** 文件类型小图标（14px 线性，currentColor 随主题）。 */
function FileIcon({ kind }: { kind: FileIconKind }) {
  return (
    <svg
      className="file-svg-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={kind}
    >
      {kind === "dir" && (
        <path d="M1.8 4.4c0-.8.6-1.4 1.4-1.4h2.9l1.5 1.7h5.2c.8 0 1.4.6 1.4 1.4v5.7c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4V4.4Z" />
      )}
      {kind === "text" && (
        <>
          <path d="M3.6 1.9h5.6l3.2 3.2v9H3.6v-12.2Z" />
          <path d="M9.2 1.9v3.2h3.2" />
          <path d="M5.6 8h4.8M5.6 10.2h4.8M5.6 12.4h3" />
        </>
      )}
      {kind === "image" && (
        <>
          <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.2" />
          <circle cx="5.7" cy="6" r="1.1" />
          <path d="m3 12.2 3.3-3.2 2.3 2.3 2.1-2.1 2.3 2.3" />
        </>
      )}
      {kind === "archive" && (
        <>
          <path d="M3.6 1.9h5.6l3.2 3.2v9H3.6v-12.2Z" />
          <path d="M6.4 1.9v2.6M8.4 1.9v2.6" />
          <path d="M6.2 7.2h3.2v3.4H6.2V7.2Z" />
        </>
      )}
      {kind === "file" && <path d="M3.6 1.9h5.6l3.2 3.2v9H3.6v-12.2Z" />}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 权限九宫格（2026-10-16 用户反馈：裸八进制输入框不直观——参照经典 FTP 客户端
// 的 所有者/组/其他 × 读/写/执行 复选矩阵，与八进制输入双向同步）。
// ---------------------------------------------------------------------------

/** POSIX 位序 9 元布尔（owner rwx / group rwx / other rwx，高位在前）。 */
export function modeToPermBits(mode: number): boolean[] {
  const m = mode & 0o777;
  return Array.from({ length: 9 }, (_, i) => ((m >> (8 - i)) & 1) === 1);
}

/** 位 → mode（与 modeToPermBits 互逆）。 */
export function permBitsToMode(bits: boolean[]): number {
  return bits.reduce((acc, on, i) => acc + (on ? 1 << (8 - i) : 0), 0);
}

/** mkdir/rename/chmod/delete 的小对话框（无 window.prompt——Tauri 不支持）。 */
function PanelDialog({
  dialog,
  onClose,
  onConfirm,
}: {
  dialog: DialogState;
  onClose: () => void;
  onConfirm: (value: string) => void;
}) {
  const { t } = useTranslation();
  const isChmod = dialog.kind === "chmod";
  const isDelete = dialog.kind === "delete";
  const [value, setValue] = useState(
    dialog.kind === "rename"
      ? (dialog.target?.name ?? "")
      : "",
  );
  // chmod 九宫格态（2026-10-16 用户裁定：只留九宫格，八进制输入不显示——
  // 提交时由位算回 mode，applyDialog 侧校验照旧）。
  const [permBits, setPermBits] = useState<boolean[]>(() =>
    modeToPermBits(dialog.target?.mode ?? 0o644),
  );
  function setBitAt(i: number, on: boolean) {
    const next = [...permBits];
    next[i] = on;
    setPermBits(next);
  }
  // Esc 关闭统一交互（2026-10-09 断点清偿）：旧实现 Esc 只绑在改名 input 上，
  // delete/chmod 对话框无 input = 无 Esc 路径。input 自身的 Escape 分支移除
  // （避免双路径双触发，统一走本监听）。
  useEscClose(true, onClose);
  const titleKey =
    dialog.kind === "mkdir"
      ? "files.dlg.mkdirTitle"
      : dialog.kind === "rename"
        ? "files.dlg.renameTitle"
        : dialog.kind === "chmod"
          ? "files.dlg.chmodTitle"
          : "files.dlg.deleteTitle";
  const submitValue = isChmod ? permBitsToMode(permBits).toString(8) : value;
  return (
    <div className="overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog file-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(titleKey)}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="file-dialog"
      >
        <h2>{t(titleKey, { name: dialog.target?.name ?? "" })}</h2>
        {isChmod && (
          <div className="perm-editor" data-testid="perm-editor">
            <table className="perm-matrix" data-testid="perm-matrix">
              <thead>
                <tr>
                  <th scope="col" aria-hidden="true" />
                  <th scope="col">{t("files.dlg.permRead")}</th>
                  <th scope="col">{t("files.dlg.permWrite")}</th>
                  <th scope="col">{t("files.dlg.permExec")}</th>
                </tr>
              </thead>
              <tbody>
                {[t("files.dlg.permOwner"), t("files.dlg.permGroup"), t("files.dlg.permOthers")].map(
                  (group, g) => (
                    <tr key={group}>
                      <th scope="row">{group}</th>
                      {[0, 1, 2].map((p) => {
                        const idx = g * 3 + p;
                        return (
                          <td key={p}>
                            <input
                              type="checkbox"
                              checked={permBits[idx]}
                              data-testid={`perm-bit-${idx}`}
                              aria-label={`${group} ${permsLabel(t, p)}`}
                              onChange={(e) => setBitAt(idx, e.currentTarget.checked)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
        {!isDelete && !isChmod && (
          <input
            autoFocus
            value={value}
            data-testid="file-dialog-input"
            aria-label={t(titleKey)}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value) onConfirm(value);
            }}
          />
        )}
        {isDelete && <p>{t("files.dlg.deleteConfirm")}</p>}
        <div className="form-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button
            className={isDelete ? "btn-danger" : "btn-accent"}
            disabled={!isDelete && !submitValue}
            onClick={() => onConfirm(isDelete ? "" : submitValue)}
            data-testid="file-dialog-confirm"
          >
            {isDelete ? t("common.delete") : t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 列头权限名（读/写/执行）——aria 标签用，独立小函数免在 map 里闭包传参。 */
function permsLabel(t: (k: string) => string, p: number): string {
  return t(p === 0 ? "files.dlg.permRead" : p === 1 ? "files.dlg.permWrite" : "files.dlg.permExec");
}

/** 排序列头单元格：激活列显方向箭头 + aria-sort；独立小组件免 map 闭包。 */
function SortHeaderCell({
  sortKey,
  side,
  label,
  extraClass,
  sort,
  onToggle,
}: {
  sortKey: SortKey;
  side: Side;
  label: string;
  extraClass?: string;
  sort: SortSpec;
  onToggle: () => void;
}) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      className={`file-head-cell${extraClass ?? ""}${active ? " active" : ""}`}
      onClick={onToggle}
      data-testid={`file-sort-${side}-${sortKey}`}
      aria-sort={active ? (sort.asc ? "ascending" : "descending") : "none"}
      aria-label={`${label} · ${sort.asc ? "▲" : "▼"}`}
    >
      {label}
      {active && (
        <span aria-hidden="true">{sort.asc ? "↑" : "↓"}</span>
      )}
    </button>
  );
}
