// SyncDialog（Phase 5 Task 4）：同步流程对话框——三态判定的 UI 面。
//
// 状态机（消费 T3 SyncStore.status 的三态动作，本组件只做「动作 → 确认面」）：
//   checking → nochannel（未配置通道）
//            → askpass（钥匙链无口令；可勾选记住）
//            → synced（一致，信息面）
//            → push（仅本机变：范围勾选 → 推送确认）
//            → pull（仅远端变：恢复范围勾选 + 逐分类覆盖预告 → 应用确认）
//            → conflict（ConflictDialog 逐分类裁定 → 合并执行）
//            → running → done / error（auth 错误回到 askpass）。
//
// 冲突合并语义（envelope 全量语义推论，报告披露）：先 pull(裁定=云端分类)
// 全量替换入本机，再 push(有数据分类并集) 发布合并结果——push 载荷是整份
// 信封（范围外分类写空数组），只推裁定分类会把云端其余分类清空，故发布面
// = 本机或云端任一侧有数据的全部分类（保云端完整，宁多推不丢数据）。
//
// 红线延伸：pull 与「保留云端」同属覆盖本机——pull 确认面按**勾选的分类**
// 逐类亮出将被覆盖的本机数据清单（与冲突裁定同一覆盖预告语义）。
//
// 依赖注入：SyncDialogModel（store + 快照/口令/通道面）——测试注入假件；
// 生产 = productionSyncModel（vault bridge + 通道 transport + 钥匙链命令）。
//
// 解困（ui-batch2 T4，审计 A5——39 号截图「正在检查同步状态…」困死）：
// 伪 home 无系统钥匙链时 sync_passphrase_get 的 SecItem 访问会弹**系统级**
// 授权框阻塞 invoke（前端不可中断），checking 态关闭钮 disabled + 无 Esc
// 路径 → 对话框结构性困死。修复两路并施：
//   1) 取消路径（结构性）：关闭钮/Esc 在 busy 态**恒可达**——关 = 放弃本次
//      同步运行（run seq 自增，在途/迟到的 settle 一律丢弃不回填；后台任务
//      若最终完成只影响远端/基线真源，下次打开重走 status 即见，无半程态）；
//   2) 检查超时（体验收敛）：channelReady/passphrase/status 统一 10s 上限，
//      超时转 error 面（重试 + 关闭恢复可用），对话框不再永久转圈。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EnvelopeError } from "./envelope";
import {
  SYNC_CATEGORIES,
  type SyncCategory,
  type SyncData,
} from "./engine";
import {
  createSyncStore,
  tauriSyncBridge,
  type SyncImportReport,
  type SyncStore,
} from "./SyncStore";
import { buildTransport, loadChannelSettings } from "./SyncSettings";
import { ConflictDialog, EntryList, entrySummaries } from "./ConflictDialog";
import { Checkbox } from "../ui/Checkbox";
import type { SyncTransport } from "./transport";
import { openEnvelope, utf8 } from "./envelope";

/** 对话框依赖面（生产接线见 {@link productionSyncModel}）。 */
export interface SyncDialogModel {
  store: SyncStore;
  /** 本机全量快照（拉取覆盖预告 / 冲突对照的「本机」侧）。 */
  localSnapshot(): Promise<SyncData>;
  /** 云端开封快照（冲突对照的「云端」侧）。 */
  remoteSnapshot(passphrase: string): Promise<SyncData>;
  /** 记住的信封口令（钥匙链）；无 = null。 */
  passphrase(): Promise<string | null>;
  /** 「记住口令」勾选时的保存面。 */
  savePassphrase(passphrase: string): Promise<void>;
  /** 通道是否已配置（false → nochannel 面）。 */
  channelReady(): Promise<boolean>;
}

/** 生产接线：vault bridge + 设置驱动通道 transport + 钥匙链口令。
 * transport 在首次使用时从设置加载并缓存（store 构造是同步的，借一个
 * 委托 transport 收口；未配置通道时委托面显式抛错）。 */
export function productionSyncModel(): SyncDialogModel {
  const bridge = tauriSyncBridge();
  let cached: SyncTransport | null = null;
  const ensureTransport = async (): Promise<SyncTransport> => {
    if (cached !== null) return cached;
    const cfg = await loadChannelSettings();
    if (cfg.kind === null) throw new Error("sync channel is not configured");
    cached = buildTransport(cfg.kind, cfg);
    return cached;
  };
  const delegate: SyncTransport = {
    kind: "lazy",
    fetch: () => ensureTransport().then((t) => t.fetch()),
    push: (envelope) => ensureTransport().then((t) => t.push(envelope)),
    test: () => ensureTransport().then((t) => t.test()),
  };
  const invokeCmd = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  };
  return {
    store: createSyncStore({ bridge, transport: delegate }),
    localSnapshot: () => bridge.exportCategories([...SYNC_CATEGORIES]),
    remoteSnapshot: async (passphrase) => {
      const t = await ensureTransport();
      const envelope = await t.fetch();
      if (envelope === null) throw new Error("remote has no sync envelope");
      return JSON.parse(utf8.decode(await openEnvelope(envelope, passphrase))) as SyncData;
    },
    passphrase: async () => {
      const stored = await invokeCmd<string | null>("sync_passphrase_get");
      return stored === null || stored === "" ? null : stored;
    },
    savePassphrase: (passphrase) => invokeCmd<void>("sync_passphrase_set", { value: passphrase }),
    channelReady: async () => {
      try {
        await ensureTransport();
        return true;
      } catch {
        return false;
      }
    },
  };
}

type Phase =
  | "checking"
  | "nochannel"
  | "askpass"
  | "synced"
  | "push"
  | "pull"
  | "conflict"
  | "running"
  | "done"
  | "error";

/** 检查流超时上限（A5 解困）：盖过钥匙链系统弹窗的「正常确认时长」，又不至
 * 于让用户面对无限转圈（39 号缺陷的可感面）。 */
const CHECK_TIMEOUT_MS = 10_000;

/** 检查流超时（区别于网络/信封错误：提示语指向钥匙链/通道无响应）。 */
class CheckTimeoutError extends Error {
  constructor() {
    super("sync check timed out");
  }
}

/** 给检查流的一步挂超时。超时后底层 promise 照常继续（系统弹窗无法中断），
 * 其迟到 settle 由 run seq 守卫丢弃——这里只负责把 UI 从 busy 里放出来。 */
function withCheckTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CheckTimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface DoneInfo {
  kind: "push" | "pull" | "conflict";
  report?: SyncImportReport;
}

export interface SyncDialogProps {
  open: boolean;
  onClose: () => void;
  /** 测试注入；省缺 = 生产接线（设置驱动）。 */
  model?: SyncDialogModel;
}

export function SyncDialog({ open, onClose, model }: SyncDialogProps) {
  const { t } = useTranslation();
  const [m, setM] = useState<SyncDialogModel | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<Awaited<ReturnType<SyncStore["status"]>> | null>(null);
  const [pass, setPass] = useState<string | null>(null);
  const [askpassInput, setAskpassInput] = useState("");
  const [askpassSave, setAskpassSave] = useState(true);
  const [pushScope, setPushScope] = useState<SyncCategory[]>([]);
  const [restoreScope, setRestoreScope] = useState<SyncCategory[]>([]);
  const [localData, setLocalData] = useState<SyncData | null>(null);
  const [remoteData, setRemoteData] = useState<SyncData | null>(null);
  const [done, setDone] = useState<DoneInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** 运行代序（A5 解困）：每次打开/放弃即自增；异步延续只在其代序仍是当前
   * 代序时才允许 setState——过期运行的迟到 settle（超时后终到的 status、
   * 放弃后才完成的 push/pull）一律丢弃，防困死残留与新开运行被旧结果覆盖。 */
  const runSeqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    const seq = ++runSeqRef.current;
    setPhase("checking");
    setStatus(null);
    setPass(null);
    setAskpassInput("");
    setAskpassSave(true);
    setLocalData(null);
    setRemoteData(null);
    setDone(null);
    setErrorMsg(null);
    const inst = model ?? productionSyncModel();
    setM(inst);
    void bootCheck(inst, seq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, model]);

  /** 检查流（channelReady → passphrase → runStatus）统配 10s 上限；超时转
   * error 面（关闭/重试恢复可用），不再永久「正在检查同步状态…」。 */
  async function bootCheck(inst: SyncDialogModel, seq: number): Promise<void> {
    let stored: string | null;
    try {
      const ready = await withCheckTimeout(inst.channelReady(), CHECK_TIMEOUT_MS);
      if (seq !== runSeqRef.current) return;
      if (!ready) {
        setPhase("nochannel");
        return;
      }
      // 已知挂点：无钥匙链环境 sync_passphrase_get 弹系统授权框阻塞 invoke。
      stored = await withCheckTimeout(inst.passphrase(), CHECK_TIMEOUT_MS);
    } catch (e) {
      if (seq !== runSeqRef.current) return;
      setErrorMsg(
        e instanceof CheckTimeoutError
          ? t("sync.dialog.checkTimeout")
          : e instanceof Error
            ? e.message
            : String(e),
      );
      setPhase("error");
      return;
    }
    if (seq !== runSeqRef.current) return;
    if (stored === null) {
      setPhase("askpass");
      return;
    }
    setPass(stored);
    await runStatus(inst, stored);
  }

  /** 关闭（busy 中亦可达，A5 解困）：放弃本次同步运行——代序自增使在途/
   * 迟到的 settle 全部丢弃；后台任务若最终完成只影响真源，不回填本面。 */
  function abandonAndClose() {
    runSeqRef.current += 1;
    onClose();
  }

  // Esc = 关闭钮的键盘等价（39 号缺陷「Esc 无效」的直接清偿）：对话框开着
  // 期间挂 document 级监听，busy 与否一视同仁。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      abandonAndClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);

  async function runStatus(m: SyncDialogModel, passphrase: string): Promise<void> {
    const seq = runSeqRef.current;
    setPhase("checking");
    try {
      const st = await withCheckTimeout(m.store.status(passphrase), CHECK_TIMEOUT_MS);
      if (seq !== runSeqRef.current) return;
      setStatus(st);
      switch (st.action) {
        case "synced":
          setPhase("synced");
          return;
        case "push":
          setPushScope(await m.store.getScope("push"));
          setPhase("push");
          return;
        case "pull":
          setRestoreScope(await m.store.getScope("restore"));
          setLocalData(await m.localSnapshot());
          setPhase("pull");
          return;
        case "conflict":
          const [local, remote] = await Promise.all([
            m.localSnapshot(),
            m.remoteSnapshot(passphrase),
          ]);
          setLocalData(local);
          setRemoteData(remote);
          setPhase("conflict");
          return;
      }
    } catch (e) {
      if (seq !== runSeqRef.current) return;
      if (e instanceof CheckTimeoutError) {
        setErrorMsg(t("sync.dialog.checkTimeout"));
        setPhase("error");
        return;
      }
      if (e instanceof EnvelopeError && e.reason === "auth") {
        setPass(null);
        setErrorMsg(t("sync.dialog.wrongPass"));
        setPhase("askpass");
        return;
      }
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function submitAskpass() {
    if (askpassInput === "" || m === null) return;
    const seq = runSeqRef.current;
    if (askpassSave) {
      try {
        await m.savePassphrase(askpassInput);
      } catch {
        // 记不住（无钥匙链环境）：不阻断本次同步，口令仅本会话内存。
      }
    }
    if (seq !== runSeqRef.current) return; // 保存途中对话框已被弃/重开
    setPass(askpassInput);
    await runStatus(m, askpassInput);
  }

  /** 统一执行壳：running → done；auth 错回 askpass，其余错误入 error 面。
   * 迟到 settle 由代序守卫丢弃（放弃后完成的 push/pull 不回填已弃的面）。 */
  async function perform(action: () => Promise<DoneInfo>) {
    const seq = runSeqRef.current;
    setErrorMsg(null);
    setPhase("running");
    try {
      const info = await action();
      if (seq !== runSeqRef.current) return;
      setDone(info);
      setPhase("done");
    } catch (e) {
      if (seq !== runSeqRef.current) return;
      if (e instanceof EnvelopeError && e.reason === "auth") {
        setPass(null);
        setErrorMsg(t("sync.dialog.wrongPass"));
        setPhase("askpass");
        return;
      }
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  async function startPush() {
    if (m === null) return;
    const scope = pushScope;
    await perform(async () => {
      await m.store.setScope("push", scope);
      await m.store.push(pass ?? "", scope);
      return { kind: "push" };
    });
  }

  async function startPull() {
    if (m === null) return;
    const scope = restoreScope;
    await perform(async () => {
      await m.store.setScope("restore", scope);
      const result = await m.store.pull(pass ?? "", scope);
      return { kind: "pull", report: result.report };
    });
  }

  async function applyConflict(resolution: Partial<Record<SyncCategory, "local" | "cloud">>) {
    if (m === null) return;
    const cloudCats = SYNC_CATEGORIES.filter((c) => resolution[c] === "cloud");
    await perform(async () => {
      if (cloudCats.length > 0) {
        await m.store.pull(pass ?? "", cloudCats);
      }
      // 发布面 = 双侧任一有数据的分类 ∪ 裁定分类（信封全量语义，见文件头）。
      const pushCats = SYNC_CATEGORIES.filter(
        (c) =>
          resolution[c] !== undefined ||
          (localData?.categories[c]?.length ?? 0) > 0 ||
          (remoteData?.categories[c]?.length ?? 0) > 0,
      );
      await m.store.push(pass ?? "", pushCats);
      return { kind: "conflict" };
    });
  }

  if (!open) return null;

  const busy = phase === "running" || phase === "checking";

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("sync.dialog.title")} data-testid="sync-dialog">
      <div className="dialog settings-dialog" aria-busy={busy}>
        <h2>{t("sync.dialog.title")}</h2>

        {phase === "checking" && (
          <p className="dialog-intro" data-testid="sync-checking">
            {t("sync.dialog.checking")}
          </p>
        )}

        {phase === "nochannel" && (
          <p className="dialog-intro" data-testid="sync-nochannel">
            {t("sync.dialog.noChannel")}
          </p>
        )}

        {phase === "askpass" && (
          <form
            className="wizard-step"
            noValidate
            data-testid="sync-askpass"
            onSubmit={(e) => {
              e.preventDefault();
              void submitAskpass();
            }}
          >
            <p className="dialog-intro">{t("sync.dialog.askpass")}</p>
            <label>
              <span>{t("sync.passphrase.title")}</span>
              <input
                type="password"
                data-testid="sync-askpass-input"
                autoComplete="off"
                value={askpassInput}
                onChange={(e) => setAskpassInput(e.currentTarget.value)}
              />
            </label>
            <label className="settings-row">
              <Checkbox
                testid="sync-askpass-save"
                checked={askpassSave}
                onChange={(e) => setAskpassSave(e.currentTarget.checked)}
              />
              {t("sync.dialog.askpassSave")}
            </label>
            {errorMsg !== null && (
              <p className="form-error" data-testid="sync-askpass-error">
                {errorMsg}
              </p>
            )}
            <div className="form-actions">
              <button type="button" data-testid="sync-askpass-cancel" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn-accent" data-testid="sync-askpass-continue" disabled={askpassInput === ""}>
                {t("sync.dialog.continue")}
              </button>
            </div>
          </form>
        )}

        {phase === "synced" && status !== null && (
          <div data-testid="sync-synced">
            <p className="dialog-intro">{t("sync.dialog.synced")}</p>
            <p className="settings-hint" data-testid="sync-last-sync">
              {status.baseline?.saved_at
                ? t("sync.dialog.lastSync", { time: new Date(status.baseline.saved_at * 1000).toLocaleString() })
                : t("sync.dialog.never")}
            </p>
          </div>
        )}

        {phase === "push" && (
          <div data-testid="sync-push-panel">
            <p className="dialog-intro">{t("sync.dialog.pushTitle")}</p>
            <p className="settings-hint">{t("sync.dialog.pushDesc")}</p>
            <fieldset className="sync-conflict-row">
              <legend>{t("sync.dialog.pushScope")}</legend>
              {SYNC_CATEGORIES.map((cat) => (
                <label key={cat} className="sync-scope-row">
                  <Checkbox
                    testid={`push-scope-${cat}`}
                    checked={pushScope.includes(cat)}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setPushScope((scope) => (on ? [...scope, cat] : scope.filter((c) => c !== cat)));
                    }}
                  />
                  {t(`sync.category.${cat}`)}
                </label>
              ))}
            </fieldset>
            <div className="form-actions">
              <button type="button" data-testid="sync-push-start" className="btn-accent" disabled={pushScope.length === 0} onClick={() => void startPush()}>
                {t("sync.dialog.pushStart")}
              </button>
            </div>
          </div>
        )}

        {phase === "pull" && localData !== null && (
          <div data-testid="sync-pull-panel">
            <p className="dialog-intro">{t("sync.dialog.pullTitle")}</p>
            <p className="settings-hint">{t("sync.dialog.pullDesc")}</p>
            <fieldset className="sync-conflict-row">
              <legend>{t("sync.dialog.restoreScope")}</legend>
              {SYNC_CATEGORIES.map((cat) => {
                const checked = restoreScope.includes(cat);
                return (
                  <div key={cat}>
                    <label className="sync-scope-row">
                      <Checkbox
                        testid={`restore-scope-${cat}`}
                        checked={checked}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          setRestoreScope((scope) => (on ? [...scope, cat] : scope.filter((c) => c !== cat)));
                        }}
                      />
                      {t(`sync.category.${cat}`)}
                    </label>
                    {checked && (
                      <div className="sync-overwrite-disclosure" data-testid={`pull-overwrite-${cat}`}>
                        <p className="form-error">
                          {t("sync.dialog.willOverwrite", { count: localData.categories[cat].length })}
                        </p>
                        <EntryList
                          testid={`pull-overwrite-entries-${cat}`}
                          summaries={entrySummaries(cat, localData)}
                          t={t}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>
            <div className="form-actions">
              <button
                type="button"
                data-testid="sync-pull-start"
                className="btn-accent"
                disabled={restoreScope.length === 0}
                onClick={() => void startPull()}
              >
                {t("sync.dialog.pullStart")}
              </button>
            </div>
          </div>
        )}

        {phase === "conflict" && status?.conflicts && localData !== null && remoteData !== null && (
          <div data-testid="sync-conflict-panel">
            <p className="dialog-intro">{t("sync.dialog.conflictTitle")}</p>
            <ConflictDialog
              conflicts={status.conflicts}
              localData={localData}
              remoteData={remoteData}
              busy={busy}
              onApply={(resolution) => void applyConflict(resolution)}
            />
          </div>
        )}

        {phase === "running" && (
          <p className="dialog-intro" data-testid="sync-running">
            {t("sync.dialog.running")}
          </p>
        )}

        {phase === "done" && done !== null && (
          <div data-testid="sync-done">
            <p className="dialog-intro" data-testid="sync-done-text">
              {done.kind === "push"
                ? t("sync.dialog.donePush")
                : done.kind === "pull"
                  ? t("sync.dialog.donePull")
                  : t("sync.dialog.doneConflict")}
            </p>
            {done.report && (
              <p className="settings-hint" data-testid="sync-done-report">
                {t("sync.dialog.applied", {
                  applied: Object.keys(done.report.applied).length,
                  skipped: Object.values(done.report.skipped).reduce((a, b) => a + b, 0),
                })}
              </p>
            )}
          </div>
        )}

        {phase === "error" && (
          <div data-testid="sync-error">
            <p className="form-error">{t("sync.dialog.failed")}</p>
            <p className="settings-hint" data-testid="sync-error-text">
              {errorMsg}
            </p>
            <div className="form-actions">
              <button type="button" data-testid="sync-retry" onClick={() => pass !== null && m !== null && void runStatus(m, pass)}>
                {t("sync.dialog.retry")}
              </button>
            </div>
          </div>
        )}

        <div className="form-actions">
          {/* busy 中亦可达（A5 解困）：点击 = 放弃本次同步（见 abandonAndClose）。 */}
          <button type="button" data-testid="sync-dialog-close" onClick={abandonAndClose}>
            {t("sync.dialog.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
