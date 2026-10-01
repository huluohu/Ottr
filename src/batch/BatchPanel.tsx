// BatchPanel（Phase 3 Task 4，B6）：批量执行面板（顶栏入口对话框——
// OverviewPage/ForwardPanel 同款「全局面 → 顶栏」布局语言）。
//
// * 主机选择 = HostTree 多选模式（行点击切换勾选；管理工具栏让位）；
// * 命令 = 手输或选 snippet（snippets 是低频读取，vaultApi 直取不进全局
//   store——vault/store 同款纪律）；`{{var}}` 变量经 ./template 抽取，
//   变量表单 = 已选主机 × 变量（同一模板按每台变量渲染出各自命令串）；
// * 执行 = batch_exec（Rust 并发池，并发/超时面板可调，缺省 5 / 30s），
//   结果经 ottr://batch-result 事件 → ./batchStore 逐主机到达；
// * 安全面 = ai/danger 的 classify 全量过一遍 per-host 渲染命令（取最高档）：
//   green 一键执行 / yellow 二击 / red 红字 armed 二击（InsertRow T13 语义）；
// * 结果 = 表格（主机/状态/退出码/耗时/输出摘要折叠）+ 差异高亮
//   （./diff 行集合等值分组：多数派组折叠为一组、少数派行高亮 + 行级标注）；
// * 会话面（R-1 裁定）：已连标签会话复用（host → 活动标签根会话 rustId，
//   rootRustIdByHost 复用 OverviewPage 纯函数）；未连主机仍下发（session_id
//   空串）→ Rust resolve 失败 → per-host failed 结果「未连接」，表格如实呈现。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HostTree } from "../hosts/HostTree";
import { rootRustIdByHost } from "../monitor/OverviewPage";
import { useSessionStore } from "../session/SessionStore";
import { useVaultStore } from "../vault/store";
import { vaultApi, type Snippet } from "../vault/api";
import { classify, type TrafficLight } from "../ai/danger";
import { batchApi, type BatchResult, type BatchStatus, type BatchTargetInput } from "./api";
import { useBatchStore } from "./batchStore";
import { diffOutputs, type DiffLine } from "./diff";
import { extractVars, renderSnippet } from "./template";

export interface BatchPanelProps {
  open: boolean;
  onClose: () => void;
}

/** 分档 → i18n 键（InsertRow 同款）。 */
function levelKey(level: TrafficLight): string {
  return level === "red" ? "ai.levelRed" : level === "yellow" ? "ai.levelYellow" : "ai.levelGreen";
}

function statusKey(status: BatchStatus): string {
  return `batch.status${status[0].toUpperCase()}${status.slice(1)}`;
}

/** 输出折叠摘要的首行（无输出给占位）。 */
function firstLine(output: string): string {
  const line = output.split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** 差异行渲染（少数派行级标注；非差异行不包 span）。 */
function DiffOutput({ lines }: { lines: DiffLine[] }) {
  return (
    <>
      {lines.map((l, i) =>
        l.differs ? (
          <span key={i} className="batch-diff-line" data-testid="batch-diff-line">
            {l.text}
          </span>
        ) : (
          <span key={i}>{l.text}</span>
        ),
      )}
    </>
  );
}

export function BatchPanel({ open, onClose }: BatchPanelProps) {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);
  const sessions = useSessionStore((s) => s.sessions);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set());
  const [body, setBody] = useState("");
  const [snippets, setSnippets] = useState<Snippet[] | null>(null);
  const [concurrency, setConcurrency] = useState(5);
  const [timeoutSecs, setTimeoutSecs] = useState(30);
  const [varValues, setVarValues] = useState<Record<number, Record<string, string>>>({});
  const [invokeError, setInvokeError] = useState<string | null>(null);
  // 分档确认状态机（InsertRow T13 语义）：null → confirm（yellow）→ armed（red）
  const [stage, setStage] = useState<"idle" | "confirm" | "armed">("idle");

  const batchId = useBatchStore((s) => s.batchId);
  const results = useBatchStore((s) => s.results);
  const total = useBatchStore((s) => s.total);
  const begin = useBatchStore((s) => s.begin);
  const reset = useBatchStore((s) => s.reset);

  // 打开时拉 snippet 清单（低频直取；失败静默——选择器显示空）
  useEffect(() => {
    if (!open || snippets !== null) return;
    void vaultApi.snippets
      .list()
      .then(setSnippets)
      .catch(() => setSnippets([]));
  }, [open, snippets]);

  const rustByHost = useMemo(() => rootRustIdByHost(sessions), [sessions]);
  const vars = useMemo(() => extractVars(body), [body]);

  const selectedHosts = useMemo(
    () => hosts.filter((h) => selectedIds.has(h.id)),
    [hosts, selectedIds],
  );

  /** per-host 渲染命令（变量表单缺项 = 显式空串；未知键原样保留）。 */
  const commands = useMemo(
    () =>
      new Map(
        selectedHosts.map((h) => [h.id, renderSnippet(body, varValues[h.id] ?? {})] as const),
      ),
    [selectedHosts, body, varValues],
  );

  const targets = useMemo<BatchTargetInput[]>(
    () =>
      selectedHosts.map((h) => ({
        host_id: h.id,
        name: h.name,
        session_id: rustByHost.get(h.id) ?? "",
        command: commands.get(h.id) ?? "",
      })),
    [selectedHosts, rustByHost, commands],
  );

  // 安全面：全量渲染命令过 danger（最高档 = 整批档）
  const verdict = useMemo(() => {
    let level: TrafficLight = "green";
    const findings = new Map<string, { kind: string; level: TrafficLight; excerpt: string }>();
    for (const cmd of commands.values()) {
      const v = classify(cmd);
      if (v.level === "red") level = "red";
      else if (v.level === "yellow" && level !== "red") level = "yellow";
      for (const f of v.findings) findings.set(`${f.kind}:${f.excerpt}`, f);
    }
    return { level, findings: [...findings.values()] };
  }, [commands]);

  // 命令/选择变了 → 确认状态机复位（批次是高危动作，不沿用上一次的授权）
  useEffect(() => {
    setStage("idle");
  }, [body, selectedIds]);

  const running = batchId !== null && results.length < total;

  function toggleHost(host: (typeof hosts)[number]) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(host.id)) next.delete(host.id);
      else next.add(host.id);
      return next;
    });
  }

  function setVar(hostId: number, name: string, value: string) {
    setVarValues((prev) => ({
      ...prev,
      [hostId]: { ...(prev[hostId] ?? {}), [name]: value },
    }));
  }

  function execute() {
    if (running || targets.length === 0 || body.trim() === "") return;
    setInvokeError(null);
    reset();
    batchApi
      .exec(targets, concurrency, timeoutSecs)
      .then((id) => begin(id, targets.length))
      .catch((e) => setInvokeError(String(e)));
  }

  function onExecuteClick() {
    if (verdict.level === "green") {
      execute();
      return;
    }
    // yellow 一击确认；red 两击（第二击 armed 红字）——InsertRow 语义
    if (verdict.level === "yellow") {
      if (stage === "confirm") execute();
      else setStage("confirm");
      return;
    }
    if (stage === "armed") execute();
    else setStage("armed");
  }

  function cancelRun() {
    if (batchId !== null) void batchApi.cancel(batchId).catch(() => {});
  }

  // 差异面（hooks 纪律：必须在 open 早退之前）：只对 ok 结果做输出分组
  // （failed/timeout/canceled 无输出可比，不进 diff、单行走表格状态面）。
  const diff = useMemo(
    () =>
      diffOutputs(
        results
          .filter((r) => r.status === "ok")
          .map((r) => ({ hostId: r.host_id, name: r.name, output: r.stdout })),
      ),
    [results],
  );

  if (!open) return null;

  const counts = {
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "failed").length,
    timeout: results.filter((r) => r.status === "timeout").length,
    canceled: results.filter((r) => r.status === "canceled").length,
  };
  const finished = batchId !== null && results.length >= total;

  const execDisabled = running || targets.length === 0 || body.trim() === "";
  const execLabel =
    stage === "armed"
      ? t("batch.executeArmed")
      : stage === "confirm"
        ? t("batch.executeConfirm")
        : t("batch.execute");

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("batch.title")} data-testid="batch-panel">
      <div className="dialog batch-panel">
        <div className="dialog-head">
          <h2>{t("batch.title")}</h2>
          <button className="dialog-close" aria-label={t("common.close")} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="batch-cols">
          <div className="batch-col-hosts">
            <h3>{t("batch.hostSection")}</h3>
            <HostTree
              selectedId={null}
              onSelect={() => {}}
              onOpen={() => {}}
              onEdit={() => {}}
              onAdd={() => {}}
              onImport={() => {}}
              multiSelect
              selectedIds={selectedIds}
              onToggle={toggleHost}
            />
            <p className="batch-hint" data-testid="batch-selected-count">
              {t("batch.selectedCount", { count: selectedIds.size })}
            </p>
            {selectedHosts.some((h) => rustByHost.get(h.id) == null) && (
              <p className="batch-hint batch-nc" data-testid="batch-nc-hint">
                {t("batch.notConnectedHint", {
                  count: selectedHosts.filter((h) => rustByHost.get(h.id) == null).length,
                })}
              </p>
            )}
          </div>

          <div className="batch-col-form">
            <div className="batch-form-row">
              <label htmlFor="batch-snippet">{t("batch.snippetLabel")}</label>
              <select
                id="batch-snippet"
                data-testid="batch-snippet"
                value=""
                onChange={(e) => {
                  const snip = snippets?.find((s) => s.id === Number(e.target.value));
                  if (snip) setBody(snip.body);
                }}
              >
                <option value="">{t("batch.snippetChoose")}</option>
                {(snippets ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="batch-form-row">
              <label htmlFor="batch-body">{t("batch.commandSection")}</label>
              <textarea
                id="batch-body"
                data-testid="batch-body"
                rows={3}
                value={body}
                placeholder={t("batch.commandPlaceholder")}
                onChange={(e) => setBody(e.currentTarget.value)}
              />
            </div>

            {vars.length > 0 && selectedHosts.length > 0 && (
              <div className="batch-vars-wrap">
                <h3>{t("batch.varSection")}</h3>
                <table className="batch-vars" data-testid="batch-vars">
                  <thead>
                    <tr>
                      <th>{t("batch.varColumnHost")}</th>
                      {vars.map((v) => (
                        <th key={v}>{`{{${v}}}`}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedHosts.map((h) => (
                      <tr key={h.id}>
                        <td>
                          {h.name}
                          {rustByHost.get(h.id) == null && (
                            <span className="batch-nc" data-testid={`batch-nc-${h.id}`}>
                              {t("batch.notConnected")}
                            </span>
                          )}
                        </td>
                        {vars.map((v) => (
                          <td key={v}>
                            <input
                              data-testid={`batch-var-${h.id}-${v}`}
                              value={varValues[h.id]?.[v] ?? ""}
                              onChange={(e) => setVar(h.id, v, e.currentTarget.value)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="batch-params">
              <label>
                {t("batch.concurrency")}
                <input
                  type="number"
                  data-testid="batch-concurrency"
                  min={1}
                  max={32}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.currentTarget.value) || 1)}
                />
              </label>
              <label>
                {t("batch.timeout")}
                <input
                  type="number"
                  data-testid="batch-timeout"
                  min={1}
                  max={3600}
                  value={timeoutSecs}
                  onChange={(e) => setTimeoutSecs(Number(e.currentTarget.value) || 1)}
                />
              </label>
            </div>

            <div className="batch-actions">
              <span className={`ai-level ai-level-${verdict.level}`} data-testid="batch-level">
                {t(levelKey(verdict.level))}
              </span>
              {verdict.findings.map((f, i) => (
                <span key={i} className="batch-finding">
                  {t(`ai.danger.${f.kind}`, { defaultValue: f.kind })}
                </span>
              ))}
              <button
                className={`btn-accent batch-exec${stage === "armed" ? " armed" : ""}`}
                data-testid="batch-execute"
                data-stage={stage}
                disabled={execDisabled}
                onClick={onExecuteClick}
              >
                {execLabel}
              </button>
              {running && (
                <button data-testid="batch-cancel" onClick={cancelRun}>
                  {t("batch.cancel")}
                </button>
              )}
            </div>
            {invokeError && (
              <p className="form-error" data-testid="batch-error">
                {t("batch.execFailed")}: {invokeError}
              </p>
            )}
            {running && (
              <p className="batch-progress" data-testid="batch-progress">
                {t("batch.running", { done: results.length, total })}
              </p>
            )}
          </div>
        </div>

        {results.length > 0 && (
          <div className="batch-results" data-testid="batch-results">
            <h3>{t("batch.resultTitle")}</h3>
            {finished && (
              <p className="batch-summary" data-testid="batch-summary">
                {t("batch.done", counts)}
              </p>
            )}
            {/* 差异高亮（行集合等值分组）：全同单组折叠为一行组摘要； */}
            {/* 多组时多数派 chip + 少数派行 data-differs 高亮 + 行级标注。 */}
            {!diff.singleGroup && (
              <p className="batch-diff-head" data-testid="batch-diff-head">
                {t("batch.majorityGroup", { count: diff.majorityHosts.length })}：
                {diff.majorityHosts.join(", ")}
              </p>
            )}
            {diff.singleGroup && diff.groups.length === 1 && (
              <details className="batch-group" data-testid="batch-group">
                <summary>
                  ✓ {t("batch.majorityGroup", { count: diff.majorityHosts.length })}：
                  {diff.majorityHosts.join(", ")}
                </summary>
                <pre className="batch-group-output">
                  {results.find((r) => r.status === "ok")?.stdout}
                </pre>
              </details>
            )}
            <table className="batch-results-table">
              <thead>
                <tr>
                  <th>{t("batch.varColumnHost")}</th>
                  <th>{t("batch.statusColumn")}</th>
                  <th>{t("batch.exitCode")}</th>
                  <th>{t("batch.duration")}</th>
                  <th>{t("batch.outputSummary")}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <ResultRow key={`${r.host_id}-${i}`} result={r} outlier={diff.outlierIds.has(r.host_id)} diff={diff} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultRow({
  result,
  outlier,
  diff,
}: {
  result: BatchResult;
  outlier: boolean;
  diff: ReturnType<typeof diffOutputs>;
}) {
  const { t } = useTranslation();
  const showDiffLines = outlier && result.status === "ok";
  return (
    <tr data-testid={`batch-row-${result.host_id}`} data-status={result.status} data-differs={outlier}>
      <td>{result.name}</td>
      <td>
        <span className={`batch-status batch-status-${result.status}`}>{t(statusKey(result.status))}</span>
        {outlier && <span className="batch-outlier">{t("batch.differsBadge")}</span>}
        {result.error && <span className="batch-err" title={result.error}>{result.error}</span>}
      </td>
      <td>{result.exit_code ?? "—"}</td>
      <td>{result.duration_ms}ms</td>
      <td>
        {(result.stdout || result.stderr) && (
          <details className="batch-output">
            <summary>
              {firstLine(result.stdout) || t("batch.outputSummary")}
              {result.truncated && <span className="batch-truncated"> {t("batch.truncated")}</span>}
            </summary>
            <pre>
              {showDiffLines ? (
                <DiffOutput lines={diff.diffLines(result.stdout)} />
              ) : (
                result.stdout
              )}
              {result.stderr && (
                <>
                  {"\n"}
                  <span className="batch-stderr">{result.stderr}</span>
                </>
              )}
            </pre>
          </details>
        )}
      </td>
    </tr>
  );
}
