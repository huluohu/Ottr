// 设置 → 快捷键（改键）——参考外部设计稿的表格式布局：
// 工具行（全部恢复默认 | 搜索）→ 表（命令 | 按键绑定 | 作用域 | 操作）。
// 按键绑定以键帽芯片逐键呈现，铅笔进入行内捕获；捕获期冲突**不退出**——
// 行内报「与「X」冲突」并保持监听，直接重按新组合即可；Backspace 恢复该行
// 默认；Esc 取消。恢复默认 = 删除覆盖条目（trash 图标，仅覆盖行显示）。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ACTIONS,
  acceleratorParts,
  findConflictGroups,
  platform as detectPlatform,
  shortcutLabel,
  type ActionId,
  type Platform,
} from "../shortcuts/registry";
import { normalizeCapture } from "../shortcuts/capture";
import { useShortcutStore } from "../shortcuts/store";

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" />
      <path d="m10.4 10.4 3 3" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M11.3 2.6l2.1 2.1-7.6 7.6-2.8.7.7-2.8 7.6-7.6z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9M6.7 7v4M9.3 7v4" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h7a3.5 3.5 0 0 1 0 7H6" />
      <path d="M6 4 3 7l3 3" />
    </svg>
  );
}

export function ShortcutSettings() {
  const { t } = useTranslation();
  const plat: Platform = detectPlatform();
  const version = useShortcutStore((s) => s.version);
  const overrides = useShortcutStore((s) => s.overrides);
  const persistApply = useShortcutStore((s) => s.persistApply);
  const resetAll = useShortcutStore((s) => s.resetAll);
  // version 订阅即重渲染信号（shortcutLabel/acceleratorParts 读模块级覆盖表）
  void version;

  const [query, setQuery] = useState("");
  const [capturingId, setCapturingId] = useState<ActionId | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const captureRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (capturingId) captureRef.current?.focus();
  }, [capturingId]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ACTIONS.filter((d) => {
      if (q === "") return true;
      const label = t(d.labelKey).toLowerCase();
      const hint = shortcutLabel(d.id, plat)?.toLowerCase() ?? "";
      return label.includes(q) || hint.includes(q) || d.id.includes(q);
    });
  }, [query, t, plat, version]);

  function labelOf(id: ActionId): string {
    const def = ACTIONS.find((a) => a.id === id);
    return def ? t(def.labelKey) : id;
  }

  function conflictText(id: ActionId, next: Partial<Record<ActionId, string>>): string | null {
    const group = findConflictGroups(next, plat).find((g) => g.includes(id));
    if (!group) return null;
    const others = group.filter((x) => x !== id).map(labelOf);
    return others.length > 0 ? t("settings.shortcuts.errConflict", { action: others.join("、") }) : null;
  }

  async function persist(next: Partial<Record<ActionId, string>>): Promise<boolean> {
    try {
      await persistApply(next);
      return true;
    } catch {
      return false;
    }
  }

  function onCaptureKeyDown(e: React.KeyboardEvent, id: ActionId) {
    e.preventDefault();
    e.stopPropagation();
    // Backspace：该行恢复默认（删除覆盖条目），并退出捕获态
    if (e.key === "Backspace") {
      setCapturingId(null);
      setCaptureError(null);
      const next = { ...overrides };
      delete next[id];
      void persist(next).then((ok) => {
        if (!ok) setResetError(t("settings.shortcuts.errPersist"));
      });
      return;
    }
    const result = normalizeCapture(e.nativeEvent, plat);
    if (result.kind === "ignore") return; // 裸修饰键：继续听
    if (result.kind === "cancel") {
      setCapturingId(null);
      setCaptureError(null);
      return;
    }
    if (result.kind === "reserved") {
      setCaptureError(t("settings.shortcuts.errReserved"));
      return; // 冲突后直接重按新组合：捕获态保持
    }
    if (result.kind === "noModifier") {
      setCaptureError(t("settings.shortcuts.errNoModifier"));
      return; // 同上
    }
    const next = { ...overrides, [id]: result.accel };
    const conflict = conflictText(id, next);
    if (conflict) {
      setCaptureError(conflict); // 冲突后直接重按新组合：捕获态保持
      return;
    }
    setCaptureError(null);
    setCapturingId(null);
    void persist(next).then((ok) => {
      if (!ok) {
        setCaptureError(t("settings.shortcuts.errPersist"));
        setCapturingId(id);
      }
    });
  }

  async function resetOne(id: ActionId) {
    const next = { ...overrides };
    delete next[id];
    if (!(await persist(next))) setResetError(t("settings.shortcuts.errPersist"));
  }

  async function resetEverything() {
    setResetError(null);
    setCapturingId(null);
    setCaptureError(null);
    const ok = await resetAll();
    if (!ok) setResetError(t("settings.shortcuts.errPersist"));
  }

  return (
    <div className="shortcut-settings" data-testid="shortcuts-pane-content" role="region" aria-label={t("settings.sectionShortcuts")}>
      <div className="shortcut-toolbar">
        <button className="btn-compact shortcut-reset-all" data-testid="shortcuts-reset-all" onClick={() => void resetEverything()}>
          <UndoIcon />
          {t("settings.shortcuts.resetAll")}
        </button>
        <div className="shortcut-search">
          <SearchIcon />
          <input
            value={query}
            placeholder={t("settings.shortcuts.search")}
            aria-label={t("settings.shortcuts.search")}
            data-testid="shortcuts-search"
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      </div>

      <div className="shortcut-table" data-testid="shortcuts-list" role="table" aria-label={t("settings.sectionShortcuts")}>
        <div className="shortcut-tr shortcut-head" role="row">
          <span role="columnheader">{t("settings.shortcuts.colCommand")}</span>
          <span role="columnheader">{t("settings.shortcuts.colBinding")}</span>
          <span role="columnheader">{t("settings.shortcuts.colScope")}</span>
          <span role="columnheader">{t("settings.shortcuts.colAction")}</span>
        </div>
        {rows.map((def) => {
          const id = def.id;
          const overridden = overrides[id] != null;
          const accel = shortcutLabel(id, plat);
          const chips = overridden
            ? acceleratorParts(overrides[id]!, plat)
            : accel
              ? acceleratorParts(accel, plat)
              : null;
          const isCapturing = capturingId === id;
          return (
            <div className="shortcut-tr shortcut-row" data-testid={`shortcut-row-${id}`} role="row" key={id}>
              <span className="shortcut-cmd" role="cell">
                {t(def.labelKey)}
              </span>
              <span className="shortcut-binding" role="cell" data-testid={`shortcut-binding-${id}`}>
                {isCapturing ? (
                  <div
                    className="shortcut-capture"
                    data-testid={`shortcut-capture-${id}`}
                    ref={captureRef}
                    tabIndex={0}
                    onKeyDown={(e) => onCaptureKeyDown(e, id)}
                    onBlur={() => {
                      // 失焦退出捕获（点击表格其他处 = 放弃本轮改键）
                      setCapturingId(null);
                      setCaptureError(null);
                    }}
                  >
                    <span className="shortcut-capture-input">{t("settings.shortcuts.capturing")}</span>
                    {captureError ? (
                      <span className="shortcut-capture-err">{captureError}</span>
                    ) : (
                      <span className="shortcut-capture-hint">{t("settings.shortcuts.captureHint")}</span>
                    )}
                  </div>
                ) : (
                  <>
                    <span className="shortcut-keys" data-testid={`shortcut-keys-${id}`}>
                      {(chips ?? []).map((chip, i) => (
                        <kbd className="shortcut-kbd" key={`${id}-${i}`}>
                          {chip}
                        </kbd>
                      ))}
                      {chips == null && <span className="settings-hint">—</span>}
                      <button
                        className="shortcut-icon-btn"
                        data-testid={`shortcut-edit-${id}`}
                        aria-label={t("settings.shortcuts.edit")}
                        title={t("settings.shortcuts.edit")}
                        onClick={() => {
                          setResetError(null);
                          setCaptureError(null);
                          setCapturingId(id);
                        }}
                      >
                        <PencilIcon />
                      </button>
                    </span>
                  </>
                )}
              </span>
              <span className="shortcut-scope" role="cell">
                {t("settings.shortcuts.scopeGlobal")}
              </span>
              <span className="shortcut-act" role="cell">
                {overridden && (
                  <button
                    className="shortcut-icon-btn"
                    data-testid={`shortcut-reset-${id}`}
                    aria-label={t("settings.shortcuts.reset")}
                    title={t("settings.shortcuts.reset")}
                    onClick={() => void resetOne(id)}
                  >
                    <TrashIcon />
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="shortcut-tr">
            <span className="settings-hint">{t("settings.shortcuts.noMatch")}</span>
          </div>
        )}
      </div>
      {resetError && (
        <p className="form-error" data-testid="shortcuts-reset-error">
          {resetError}
        </p>
      )}
    </div>
  );
}
