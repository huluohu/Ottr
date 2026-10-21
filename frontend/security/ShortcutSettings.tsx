// 设置 → 快捷键（2026-10-21 改键功能）：动作列表 + 行内捕获改键 + 冲突/非法
// 校验 + 恢复默认。捕获 = 行进入监听态，按下任意组合键即归一（capture.ts），
// Esc 取消；校验拒绝（非法/冲突）行内报错，通过才走 store 持久化（先落库后
// 生效，写失败行内报错、内存不动）。mac 菜单同步由 store 广播的
// ottr://shortcuts-changed 触发 Rust 重建，本组件不感知。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ACTIONS,
  findConflictGroups,
  platform as detectPlatform,
  shortcutLabel,
  type ActionId,
  type Platform,
} from "../shortcuts/registry";
import { normalizeCapture } from "../shortcuts/capture";
import { useShortcutStore } from "../shortcuts/store";

export function ShortcutSettings() {
  const { t } = useTranslation();
  const plat: Platform = detectPlatform();
  const version = useShortcutStore((s) => s.version);
  const overrides = useShortcutStore((s) => s.overrides);
  const loaded = useShortcutStore((s) => s.loaded);
  const persistApply = useShortcutStore((s) => s.persistApply);
  const resetAll = useShortcutStore((s) => s.resetAll);
  // version 订阅即重渲染信号（shortcutLabel 读模块级覆盖表）
  void version;
  void loaded;

  const [query, setQuery] = useState("");
  const [capturingId, setCapturingId] = useState<ActionId | null>(null);
  const [rowError, setRowError] = useState<Partial<Record<ActionId, string>>>({});
  const captureRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ACTIONS.filter((d) => {
      if (q === "") return true;
      const label = t(d.labelKey).toLowerCase();
      const hint = shortcutLabel(d.id, plat)?.toLowerCase() ?? "";
      return label.includes(q) || hint.includes(q) || d.id.includes(q);
    });
  }, [query, t, plat, version]);

  // 捕获态键盘监听：挂在行元素上（focus 后接键）
  useEffect(() => {
    if (!capturingId) return;
    const el = captureRef.current;
    el?.focus();
  }, [capturingId]);

  function onCaptureKeyDown(e: React.KeyboardEvent, id: ActionId) {
    console.log("[dbg] capture keydown", e.key, e.metaKey, e.shiftKey, "id:", id);
    e.preventDefault();
    e.stopPropagation();
    const result = normalizeCapture(e.nativeEvent, plat);
    console.log("[dbg] result:", JSON.stringify(result));
    if (result.kind === "ignore") return; // 裸修饰键：继续听
    if (result.kind === "cancel") {
      setCapturingId(null);
      setRowError((prev) => ({ ...prev, [id]: undefined }));
      return;
    }
    if (result.kind === "reserved") {
      setRowError((prev) => ({ ...prev, [id]: t("settings.shortcuts.errReserved") }));
      return;
    }
    if (result.kind === "noModifier") {
      setRowError((prev) => ({ ...prev, [id]: t("settings.shortcuts.errNoModifier") }));
      return;
    }
    // 冲突校验：把新键位放进草稿表后按生效键位找组
    const next = { ...overrides, [id]: result.accel };
    const groups = findConflictGroups(next, plat);
    const group = groups.find((g) => g.includes(id));
    if (group) {
      const others = group.filter((x) => x !== id).map((x) => labelOf(x));
      setRowError((prev) => ({
        ...prev,
        [id]: t("settings.shortcuts.errConflict", { action: others.join("、") }),
      }));
      return;
    }
    setRowError((prev) => ({ ...prev, [id]: undefined }));
    setCapturingId(null);
    void persistApply(next).catch(() => {
      setRowError((prev) => ({ ...prev, [id]: t("settings.shortcuts.errPersist") }));
    });
  }

  function labelOf(id: ActionId): string {
    const def = ACTIONS.find((a) => a.id === id);
    return def ? t(def.labelKey) : id;
  }

  async function resetOne(id: ActionId) {
    const next = { ...overrides };
    delete next[id];
    setRowError((prev) => ({ ...prev, [id]: undefined }));
    try {
      await persistApply(next);
    } catch {
      setRowError((prev) => ({ ...prev, [id]: t("settings.shortcuts.errPersist") }));
    }
  }

  return (
    <div className="settings-dialog" data-testid="shortcuts-pane-content" role="region" aria-label={t("settings.sectionShortcuts")}>
      <div className="shortcuts-toolbar">
        <input
          className="shortcuts-search"
          data-testid="shortcuts-search"
          value={query}
          placeholder={t("settings.shortcuts.search")}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button
          className="btn-accent btn-compact"
          data-testid="shortcuts-reset-all"
          onClick={() => {
            setRowError({});
            void resetAll().catch(() =>
              setRowError({ __all__: t("settings.shortcuts.errPersist") } as never),
            );
          }}
        >
          {t("settings.shortcuts.resetAll")}
        </button>
      </div>
      <ul className="shortcuts-list" data-testid="shortcuts-list">
        {rows.map((def) => {
          const overridden = overrides[def.id] != null;
          const isCapturing = capturingId === def.id;
          return (
            <li key={def.id} className="shortcuts-row" data-testid={`shortcut-row-${def.id}`}>
              <span className="shortcuts-label">{t(def.labelKey)}</span>
              {isCapturing ? (
                <div
                  className="shortcuts-capture"
                  data-testid={`shortcut-capture-${def.id}`}
                  ref={captureRef}
                  tabIndex={0}
                  onKeyDown={(e) => onCaptureKeyDown(e, def.id)}
                  onBlur={() => setCapturingId(null)}
                >
                  {t("settings.shortcuts.capturing")}
                </div>
              ) : (
                <span className="shortcuts-keys">
                  <kbd className="palette-hint">{shortcutLabel(def.id, plat) ?? "—"}</kbd>
                  <button
                    className="btn-compact"
                    data-testid={`shortcut-edit-${def.id}`}
                    onClick={() => {
                      setRowError((prev) => ({ ...prev, [def.id]: undefined }));
                      setCapturingId(def.id);
                    }}
                  >
                    {t("settings.shortcuts.edit")}
                  </button>
                  {overridden && (
                    <button
                      className="btn-compact"
                      data-testid={`shortcut-reset-${def.id}`}
                      onClick={() => void resetOne(def.id)}
                    >
                      {t("settings.shortcuts.reset")}
                    </button>
                  )}
                </span>
              )}
              {rowError[def.id] && (
                <p className="form-error shortcuts-row-error" data-testid={`shortcut-error-${def.id}`}>
                  {rowError[def.id]}
                </p>
              )}
            </li>
          );
        })}
        {rows.length === 0 && <li className="settings-hint">{t("settings.shortcuts.noMatch")}</li>}
      </ul>
      <p className="settings-hint" data-testid="shortcuts-hint">
        {t("settings.shortcuts.hint")}
      </p>
    </div>
  );
}
