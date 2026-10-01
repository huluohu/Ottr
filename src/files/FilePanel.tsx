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
import { useTranslation } from "react-i18next";
import type { Session } from "../session/SessionStore";
import {
  fileNameOf,
  formatBytes,
  formatMode,
  joinRemote,
  localHome,
  localList,
  parentOf,
  sftpChmod,
  sftpList,
  sftpMkdir,
  sftpRealpath,
  sftpRemove,
  sftpRename,
  type DirEntry,
  type LocalEntry,
} from "./api";
import { TransferQueue } from "./TransferQueue";
import { remoteEdits } from "./RemoteEdit";
import { useTransferStore } from "./TransferStore";

type Side = "local" | "remote";

interface PaneState {
  path: string;
  entries: (DirEntry & { is_dir: boolean })[] | (LocalEntry & { is_dir: boolean })[];
  error: string | null;
  loading: boolean;
  selected: string | null;
}

function emptyPane(path: string): PaneState {
  return { path, entries: [], error: null, loading: false, selected: null };
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
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<Side | null>(null);
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
      showNotice(t("files.editFailed", { message: String(e) }));
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

  const loadLocal = useCallback(async (path: string) => {
    setLocal((p) => ({ ...p, path, loading: true, error: null, selected: null }));
    try {
      const list = await localList(path);
      const entries = Array.isArray(list) ? list : [];
      setLocal((p) => ({ ...p, entries, loading: false }));
    } catch (e) {
      setLocal((p) => ({ ...p, loading: false, error: String(e) }));
    }
  }, []);

  const loadRemote = useCallback(
    async (path: string) => {
      if (!rustId) return;
      setRemote((p) => ({ ...p, path, loading: true, error: null, selected: null }));
      try {
        const list = await sftpListFor(rustId, path);
        const entries = Array.isArray(list) ? list : [];
        setRemote((p) => ({ ...p, entries, loading: false }));
      } catch (e) {
        setRemote((p) => ({ ...p, loading: false, error: String(e) }));
      }
    },
    [rustId],
  );

  // 初载：本地 = home；远端 = realpath(".")（= home）。会话切换（含重连换
  // rustId）整体重置——面板随会话生命周期，不做跨会话路径记忆。
  useEffect(() => {
    void (async () => {
      try {
        await loadLocal(await localHome());
      } catch {
        setLocal((p) => ({ ...p, error: "cannot resolve home" }));
      }
    })();
  }, [loadLocal]);

  useEffect(() => {
    if (!rustId) {
      setRemote(emptyPane(""));
      return;
    }
    void (async () => {
      try {
        const home = await sftpRealpath(rustId, ".");
        void loadRemote(home);
      } catch (e) {
        setRemote((p) => ({ ...p, error: String(e) }));
      }
    })();
  }, [rustId, loadRemote]);

  // --- 拖拽上传（Tauri onDragDropEvent；落点命中远端栏才上传） -------------------
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
          const target: Side | null = hit === "remote" ? "remote" : null;
          if (p.type === "drop") {
            setDropTarget(null);
            if (target === "remote") void handleDrop(p.paths ?? []);
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
  }, [rustId, remote.path]);

  async function handleDrop(paths: string[]) {
    if (!rustId || paths.length === 0) return;
    let queued = 0;
    let skippedDirs = 0;
    for (const p of paths) {
      // 目录过滤：查父目录列表判定 is_dir（MVP 无 stat 命令；一次 invoke 足够）
      try {
        const siblings = await localList(parentOf(p));
        const name = fileNameOf(p);
        if (siblings.find((s) => s.name === name)?.is_dir) {
          skippedDirs++;
          continue;
        }
      } catch {
        // 判定不了就尝试上传（Rust 侧 SFTP open 失败会进队列 failed 态）
      }
      queued++;
      void startUpload(rustId, p, remote.path).catch((e) =>
        showNotice(t("files.uploadFailed", { message: String(e) })),
      );
    }
    if (skippedDirs > 0) {
      showNotice(t("files.dropDirsSkipped", { count: skippedDirs }));
    } else if (queued > 0) {
      showNotice(t("files.dropQueued", { count: queued }));
    }
  }

  // --- 操作（全部作用于 focus 侧；本地侧仅刷新——本地写操作不进 MVP） ------------

  const pane = focus === "local" ? local : remote;
  const selectedEntry = pane.entries.find((e) => e.name === pane.selected) ?? null;
  const selectedRemotePath =
    focus === "remote" && selectedEntry ? joinRemote(remote.path, selectedEntry.name) : null;

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
    const path = joinRemote((side === "local" ? local : remote).path, target?.name ?? "");
    try {
      if (kind === "mkdir") {
        await sftpMkdir(rustId!, joinRemote((side === "local" ? local : remote).path, value));
      } else if (kind === "rename" && target) {
        await sftpRename(rustId!, path, joinRemote((side === "local" ? local : remote).path, value));
      } else if (kind === "chmod" && target) {
        const mode = parseInt(value, 8);
        if (!Number.isFinite(mode) || mode < 0 || mode > 0o777) {
          throw new Error(t("files.errOctalMode"));
        }
        await sftpChmod(rustId!, path, mode);
      } else if (kind === "delete" && target) {
        await sftpRemove(rustId!, path, target.is_dir);
      }
      setDialog(null);
      if (side === "remote") void loadRemote(remote.path);
    } catch (e) {
      showNotice(t("files.opFailed", { message: String(e) }));
    }
  }

  const menuItems: { label: string; danger?: boolean; action: () => void }[] =
    focus === "remote" && rustId
      ? [
          { label: t("files.menu.refresh"), action: () => loadRemote(remote.path) },
          {
            label: t("files.menu.mkdir"),
            action: () => setDialog({ kind: "mkdir", side: "remote", target: null }),
          },
          ...(selectedEntry
            ? [
                {
                  label: t("files.menu.rename", { name: selectedEntry.name }),
                  action: () =>
                    setDialog({ kind: "rename", side: "remote", target: selectedEntry }),
                },
                {
                  label: t("files.menu.chmod", { name: selectedEntry.name }),
                  action: () => setDialog({ kind: "chmod", side: "remote", target: selectedEntry }),
                },
                {
                  label: t("files.menu.delete", { name: selectedEntry.name }),
                  danger: true,
                  action: () =>
                    setDialog({ kind: "delete", side: "remote", target: selectedEntry }),
                },
              ]
            : []),
          ...(selectedEntry && !selectedEntry.is_dir
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
                {
                  label: t("files.menu.download", { name: selectedEntry.name }),
                  action: () => openEntry("remote", selectedEntry),
                },
              ]
            : []),
        ]
      : [{ label: t("files.menu.refresh"), action: () => loadLocal(local.path) }];

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
      data-droptarget={dropTarget === side && side === "remote"}
      data-file-drop={side}
      aria-label={side === "local" ? t("files.localPane") : t("files.remotePane")}
      onPointerDown={() => setFocus(side)}
    >
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
      <div className="file-list" data-testid={`file-list-${side}`} role="listbox" aria-multiselectable={false}>
        {state.loading && <p className="file-status">{t("common.loading")}</p>}
        {state.error && (
          <p className="file-status file-error" data-testid={`file-error-${side}`}>
            {t("files.listFailed", { message: state.error })}
          </p>
        )}
        {!state.loading &&
          !state.error &&
          state.entries.map((e) => (
            <div
              key={e.name}
              role="option"
              aria-selected={state.selected === e.name}
              className="file-row"
              data-selected={state.selected === e.name}
              onClick={() =>
                side === "local"
                  ? setLocal((p) => ({ ...p, selected: e.name }))
                  : setRemote((p) => ({ ...p, selected: e.name }))
              }
              onDoubleClick={() => openEntry(side, e)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                setFocus(side);
                if (side === "remote") setRemote((p) => ({ ...p, selected: e.name }));
                setMenu({ x: ev.clientX, y: ev.clientY });
              }}
            >
              <span className="file-icon" aria-hidden>
                {e.is_dir ? "▸" : "·"}
              </span>
              <span className="file-name" title={e.name}>
                {e.name}
              </span>
              <span className="file-meta">
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
        <button onClick={() => navigate(focus, pane.path)}>{t("files.menu.refresh")}</button>
        {focus === "remote" && (
          <>
            <button data-testid="fb-mkdir" onClick={() => setDialog({ kind: "mkdir", side: "remote", target: null })}>
              {t("files.menu.mkdir")}
            </button>
            <button
              disabled={!selectedEntry}
              onClick={() => selectedEntry && setDialog({ kind: "rename", side: "remote", target: selectedEntry })}
            >
              {t("files.rename")}
            </button>
            <button
              disabled={!selectedEntry}
              onClick={() => selectedEntry && setDialog({ kind: "chmod", side: "remote", target: selectedEntry })}
            >
              {t("files.chmod")}
            </button>
            <button
              disabled={!selectedEntry}
              className="icon-btn danger"
              onClick={() => selectedEntry && setDialog({ kind: "delete", side: "remote", target: selectedEntry })}
            >
              {t("common.delete")}
            </button>
            <button
              data-testid="fb-download"
              disabled={!selectedEntry || selectedEntry.is_dir}
              onClick={() => selectedEntry && openEntry("remote", selectedEntry)}
            >
              {t("files.download")}
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
      {dialog && (
        <PanelDialog
          dialog={dialog}
          onClose={() => setDialog(null)}
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
  const [value, setValue] = useState(
    dialog.kind === "rename"
      ? (dialog.target?.name ?? "")
      : dialog.kind === "chmod"
        ? ((dialog.target?.mode ?? 0o644) & 0o777).toString(8).padStart(3, "0")
        : "",
  );
  const isDelete = dialog.kind === "delete";
  const titleKey =
    dialog.kind === "mkdir"
      ? "files.dlg.mkdirTitle"
      : dialog.kind === "rename"
        ? "files.dlg.renameTitle"
        : dialog.kind === "chmod"
          ? "files.dlg.chmodTitle"
          : "files.dlg.deleteTitle";
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
        {!isDelete && (
          <input
            autoFocus
            value={value}
            data-testid="file-dialog-input"
            aria-label={t(titleKey)}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value) onConfirm(value);
              if (e.key === "Escape") onClose();
            }}
          />
        )}
        {isDelete && <p>{t("files.dlg.deleteConfirm")}</p>}
        <div className="form-actions">
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button
            className={isDelete ? "btn-danger" : "btn-accent"}
            disabled={!isDelete && !value}
            onClick={() => onConfirm(isDelete ? "" : value)}
            data-testid="file-dialog-confirm"
          >
            {isDelete ? t("common.delete") : t("common.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
