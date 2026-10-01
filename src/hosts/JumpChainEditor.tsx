// JumpChainEditor（Phase 2 Task 2，B7 下半）：跳板链编辑器（顶栏入口对话框）。
// * 列表：全部 jump_chains（链名 + hop 主机名链 `A → B → …`；末位之后接
//   target = 引用该链的主机）；编辑 / 删除（删链自动解绑引用主机）。
// * 表单：链名 + hop 有序列表——每跳从 hosts 选一台主机；排序 = 拖拽
//   （draggable + dragover/drop）与 ↑/↓ 按钮双通道（键盘可达 + 测试面）。
// * 测试连接：jc_test 按当前（未保存也可）hop 序列建真实链——**末位当
//   target**、其余当跳板；逐跳 TOFU 会弹确认框；成功立即拆除不留连接。
//   失败显示「第 N 跳失败」+ 底层原因（HopFailed 断点定位的消费面）。
// * 主题/i18n 纪律：语义令牌（--color-*），文案全走词典键。
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi, type JumpChain, type JumpTestResult } from "../vault/api";
import { useVaultStore } from "../vault/store";

export interface JumpChainEditorProps {
  open: boolean;
  onClose: () => void;
}

export function JumpChainEditor({ open, onClose }: JumpChainEditorProps) {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);
  const createJumpChain = useVaultStore((s) => s.createJumpChain);
  const updateJumpChain = useVaultStore((s) => s.updateJumpChain);
  const deleteJumpChain = useVaultStore((s) => s.deleteJumpChain);

  const [chains, setChains] = useState<JumpChain[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [hops, setHops] = useState<number[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<JumpTestResult | null>(null);
  // 拖拽排序状态：dragIndex = 手里拖的行；overIndex = 当前悬停目标（高亮）。
  const dragIndex = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const listSeq = useRef(0);

  const hostById = new Map(hosts.map((h) => [h.id, h]));

  const refresh = useCallback(async () => {
    const seq = ++listSeq.current;
    try {
      const data = await vaultApi.jumpChains.list();
      if (seq === listSeq.current) {
        setChains(data);
        setLoadError(null);
      }
    } catch (err) {
      if (seq === listSeq.current) setLoadError(String(err));
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) return null;

  function openCreate() {
    setEditingId(null);
    setName("");
    setHops(hosts.length > 0 ? [hosts[0].id] : []);
    setFormError(null);
    setTestResult(null);
    setActionError(null);
    setFormOpen(true);
  }

  function openEdit(row: JumpChain) {
    setEditingId(row.id);
    setName(row.name);
    setHops([...row.hops]);
    setFormError(null);
    setTestResult(null);
    setActionError(null);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setFormError(null);
    setTestResult(null);
  }

  function moveHop(from: number, to: number) {
    setHops((hs) => {
      if (to < 0 || to >= hs.length || from === to) return hs;
      const next = [...hs];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  async function handleTest() {
    setTesting(true);
    setActionError(null);
    try {
      const result = await vaultApi.jumpChains.test(hops);
      setTestResult(result);
    } catch (err) {
      setActionError(t("jump.actionFailed", { message: String(err) }));
    } finally {
      setTesting(false);
    }
  }

  function validate(): string | null {
    if (name.trim() === "") return t("jump.errNameRequired");
    if (hops.length === 0) return t("jump.errHopsRequired");
    return null;
  }

  async function handleSubmit() {
    const err = validate();
    if (err != null) {
      setFormError(err);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      if (editingId != null) {
        await updateJumpChain(editingId, { name: name.trim(), hops });
      } else {
        await createJumpChain({ name: name.trim(), hops });
      }
      closeForm();
      await refresh();
    } catch (submitErr) {
      setFormError(t("jump.saveFailed", { message: String(submitErr) }));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(row: JumpChain) {
    setActionError(null);
    try {
      await deleteJumpChain(row.id);
      if (editingId === row.id) closeForm();
      await refresh();
    } catch (err) {
      setActionError(t("jump.actionFailed", { message: String(err) }));
    }
  }

  /** hop 序列的人话展示（列表行）：主机名按跳序 → 连接；未知 id 兜底占位。 */
  function hopSummary(chain: JumpChain): string {
    return chain.hops
      .map((id) => hostById.get(id)?.name ?? `#${id}`)
      .join(" → ");
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={t("jump.title")}>
      <div className="dialog jump-editor" data-testid="jump-editor">
        <div className="dialog-head">
          <h2>{t("jump.title")}</h2>
          <button className="dialog-close" aria-label={t("common.close")} onClick={onClose}>
            ×
          </button>
        </div>

        {loadError && (
          <p className="form-error" data-testid="jump-load-error">
            {t("jump.loadFailed", { message: loadError })}
          </p>
        )}
        {actionError && (
          <p className="form-error" data-testid="jump-action-error">
            {actionError}
          </p>
        )}

        {chains.length === 0 && !loadError && !formOpen && (
          <p className="jump-empty" data-testid="jump-empty">
            {t("jump.empty")}
          </p>
        )}

        {!formOpen && chains.length > 0 && (
          <ul className="jump-list" data-testid="jump-list">
            {chains.map((row) => (
              <li key={row.id} className="jump-row" data-testid={`jump-row-${row.id}`}>
                <span className="jump-main">
                  <span className="jump-name">{row.name}</span>
                  <span className="jump-hops" data-testid={`jump-hops-${row.id}`}>
                    {hopSummary(row)}
                  </span>
                </span>
                <span className="jump-actions">
                  <button
                    data-testid={`jump-edit-${row.id}`}
                    onClick={() => openEdit(row)}
                    aria-label={t("common.edit")}
                  >
                    {t("common.edit")}
                  </button>
                  <button
                    data-testid={`jump-delete-${row.id}`}
                    onClick={() => void handleDelete(row)}
                    aria-label={t("common.delete")}
                  >
                    {t("common.delete")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {formOpen ? (
          <form
            className="jump-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
            noValidate
          >
            <h3>{editingId != null ? t("jump.editTitle") : t("jump.addTitle")}</h3>
            <label>
              <span>{t("jump.chainName")}</span>
              <input
                data-testid="jump-form-name"
                value={name}
                placeholder={t("jump.chainNamePlaceholder")}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </label>

            <div className="jump-hops-head">
              <span>{t("jump.hops")}</span>
              <button
                type="button"
                data-testid="jump-add-hop"
                disabled={hosts.length === 0}
                onClick={() => setHops((hs) => [...hs, hosts[0]?.id ?? 0])}
              >
                {t("jump.addHop")}
              </button>
            </div>
            {hosts.length === 0 ? (
              <p className="form-error" data-testid="jump-no-hosts">
                {t("jump.noHosts")}
              </p>
            ) : (
              <ul className="jump-hop-list" data-testid="jump-hop-list">
                {hops.map((hopId, index) => (
                  <li
                    key={`${index}-${hopId}`}
                    className="jump-hop-row"
                    data-testid="jump-hop-row"
                    data-over={overIndex === index ? "true" : undefined}
                    draggable
                    onDragStart={() => {
                      dragIndex.current = index;
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setOverIndex(index);
                    }}
                    onDragLeave={() => setOverIndex((v) => (v === index ? null : v))}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragIndex.current;
                      dragIndex.current = null;
                      setOverIndex(null);
                      if (from != null) moveHop(from, index);
                    }}
                    onDragEnd={() => {
                      dragIndex.current = null;
                      setOverIndex(null);
                    }}
                  >
                    <span className="jump-hop-index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <select
                      data-testid="jump-hop-select"
                      aria-label={t("jump.host")}
                      value={hopId}
                      onChange={(e) => {
                        // 合成事件的 currentTarget 在 handler 返回后即失效，
                        // 先取值再进 setState updater（测试实测的坑）。
                        const v = Number(e.currentTarget.value);
                        setHops((hs) => hs.map((old, i) => (i === index ? v : old)));
                      }}
                    >
                      {hosts.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                        </option>
                      ))}
                    </select>
                    <span className="jump-hop-actions">
                      <button
                        type="button"
                        data-testid="jump-hop-up"
                        aria-label={t("jump.moveUp")}
                        disabled={index === 0}
                        onClick={() => moveHop(index, index - 1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        data-testid="jump-hop-down"
                        aria-label={t("jump.moveDown")}
                        disabled={index === hops.length - 1}
                        onClick={() => moveHop(index, index + 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        data-testid="jump-hop-remove"
                        aria-label={t("jump.removeHop")}
                        onClick={() =>
                          setHops((hs) => hs.filter((_, i) => i !== index))
                        }
                      >
                        ✕
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="jump-test-row">
              <button
                type="button"
                className="btn-accent"
                data-testid="jump-test"
                disabled={testing || hops.length === 0 || hosts.length === 0}
                onClick={() => void handleTest()}
              >
                {testing ? t("jump.testing") : t("jump.test")}
              </button>
              {testResult && (
                <span
                  className="jump-test-result"
                  data-testid="jump-test-result"
                  data-ok={testResult.ok ? "true" : "false"}
                >
                  {testResult.ok
                    ? t("jump.testOk", { elapsed: (testResult.elapsed_ms / 1000).toFixed(1) })
                    : `${t("jump.testFail")}${
                        testResult.hop != null
                          ? ` · ${t("jump.testFailHop", { hop: testResult.hop + 1 })}`
                          : ""
                      }${testResult.error ? ` · ${testResult.error}` : ""}`}
                </span>
              )}
            </div>

            {formError && (
              <p className="form-error" data-testid="jump-form-error">
                {formError}
              </p>
            )}
            <div className="form-actions">
              <button type="button" onClick={closeForm}>
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="btn-accent"
                data-testid="jump-form-save"
                disabled={submitting}
              >
                {t("common.save")}
              </button>
            </div>
          </form>
        ) : (
          <div className="form-actions">
            <button className="btn-accent" data-testid="jump-add" onClick={openCreate}>
              {t("jump.add")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
