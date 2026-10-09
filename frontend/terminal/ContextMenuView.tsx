// 右键菜单渲染（自 Terminal.tsx 拆出）：含一级子菜单（编码）。纯展示组件，
// 动作经 onAction(id) 上抛。公共 API 经 Terminal.tsx 再导出保持原路径不变。
import { useState } from "react";
import { useEscClose } from "../ui/useEscClose";
import { useTranslation } from "react-i18next";
import type { ContextMenuItem } from "./ContextMenu";

/** 右键菜单渲染（含一级子菜单：编码）。纯展示：动作经 onAction(id) 上抛。 */
export function ContextMenuView({
  x,
  y,
  items,
  onAction,
  onClose,
  testPrefix,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onAction: (id: string) => void;
  /** Esc 关闭（2026-10-09 断点清偿：菜单此前只有点外/再右键，无键盘路径）。 */
  onClose: () => void;
  testPrefix: string;
}) {
  const [openSub, setOpenSub] = useState<string | null>(null);
  const { t } = useTranslation();
  useEscClose(true, onClose);
  return (
    <div
      className="ctx-menu"
      role="menu"
      aria-label={t("terminal.menuAria")}
      style={{ left: x, top: y }}
      data-testid={`ctx-menu-${testPrefix}`}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="ctx-menu-row"
          onMouseEnter={() => setOpenSub(item.children ? item.id : null)}
        >
          <button
            role="menuitem"
            className={`ctx-menu-item${item.danger ? " danger" : ""}`}
            data-checked={item.checked === true}
            disabled={item.disabled === true}
            data-testid={`ctx-${item.id}`}
            onClick={() => {
              if (item.children) {
                setOpenSub(openSub === item.id ? null : item.id);
              } else {
                onAction(item.id);
              }
            }}
          >
            <span>{item.label}</span>
            <span className="ctx-hint">{item.children ? "›" : item.checked ? "✓" : ""}</span>
          </button>
          {item.children && openSub === item.id && (
            <div className="ctx-submenu" role="menu">
              {item.children.map((sub) => (
                <button
                  key={sub.id}
                  role="menuitem"
                  className="ctx-menu-item"
                  data-checked={sub.checked === true}
                  data-testid={`ctx-${sub.id}`}
                  onClick={() => onAction(sub.id)}
                >
                  <span>{sub.label}</span>
                  <span className="ctx-hint">{sub.checked ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
