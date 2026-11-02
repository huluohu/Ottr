import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ThemeMode } from "../theme/ThemeContext";

export interface ThemeVisualPickerProps {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  modes?: readonly ThemeMode[];
  disabled?: boolean;
  testid?: string;
}

const DEFAULT_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

export function ThemeVisualPicker({
  value,
  onChange,
  modes = DEFAULT_MODES,
  disabled = false,
  testid = "theme-visual-picker",
}: ThemeVisualPickerProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>, currentMode: ThemeMode) => {
      if (disabled) return;
      const currentIndex = modes.indexOf(currentMode);
      if (currentIndex === -1) return;

      let targetIndex = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        targetIndex = (currentIndex + 1) % modes.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        targetIndex = (currentIndex - 1 + modes.length) % modes.length;
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onChange(currentMode);
        return;
      }

      if (targetIndex !== -1) {
        const nextMode = modes[targetIndex];
        onChange(nextMode);
        // 焦点跟随切换
        const buttons = rootRef.current?.querySelectorAll<HTMLDivElement>('[role="radio"]');
        buttons?.[targetIndex]?.focus();
      }
    },
    [disabled, modes, onChange],
  );

  return (
    <div
      ref={rootRef}
      className="theme-visual-picker"
      role="radiogroup"
      aria-label={t("settings.themes.system")}
      data-testid={testid}
      data-disabled={disabled ? "true" : undefined}
    >
      {modes.map((mode) => {
        const selected = value === mode;
        const label = t(`settings.themes.${mode}`, { defaultValue: mode });

        return (
          <div
            key={mode}
            role="radio"
            aria-checked={selected}
            aria-label={label}
            tabIndex={selected ? 0 : -1}
            className={`theme-preview-card${selected ? " selected" : ""}`}
            data-testid={`theme-card-${mode}`}
            data-theme={mode}
            onClick={() => {
              if (!disabled) onChange(mode);
            }}
            onKeyDown={(e) => handleKeyDown(e, mode)}
          >
            <div className={`theme-thumb theme-thumb-${mode}`}>
              <div className="thumb-bar" aria-hidden="true">
                <span className="thumb-dot dot-r" />
                <span className="thumb-dot dot-y" />
                <span className="thumb-dot dot-g" />
              </div>
              <div className="thumb-body" aria-hidden="true">
                <div className="thumb-side" />
                <div className="thumb-content">
                  <div className="thumb-line line-short" />
                  <div className="thumb-line line-long" />
                </div>
              </div>
            </div>
            <span className="theme-label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
