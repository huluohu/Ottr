// 右键菜单（Task 8，A8）：菜单模型纯工厂 + 会话级设置存取。
// 模型与渲染分离：buildContextMenu 只产出数据（id 驱动，Terminal.tsx 的
// TerminalContextMenu 负责渲染与动作分发），工厂本身可无 DOM 测试。
// i18n：文案键固定为 `terminal.<id>`（编码子菜单项例外，直接展示编码名）。
import type { TFunction } from "i18next";

/** 菜单项：id 驱动动作分发；checked = 可勾选态；children = 子菜单。 */
export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  children?: ContextMenuItem[];
  separatorAfter?: boolean;
}

/** 编码候选（Task 9 收口：与 Rust encoding_from_str 支持集一致——
 * utf-8/gbk/gb18030；big5 等其余候选 Rust 侧无解码器，删项防「选了出乱码」）。 */
export const MENU_ENCODINGS = ["utf-8", "gbk", "gb18030"] as const;

/** 构建菜单所需的上下文快照（SessionTerminal 在 contextmenu 时采集）。 */
export interface MenuContext {
  /** 终端当前有选中内容（复制项可用性）。 */
  hasSelection: boolean;
  copyOnSelect: boolean;
  /** 当前会话编码覆盖（"" = 未设置）。 */
  encoding: string;
}

/**
 * 菜单模型（简报：复制/粘贴/搜索/清屏/编码子菜单 + 分屏/选择即复制）。
 * id 一览：copy paste search clear encoding?（含子菜单）splitRight splitDown
 * closePane copyOnSelect。
 */
export function buildContextMenu(ctx: MenuContext, t: TFunction): ContextMenuItem[] {
  return [
    { id: "copy", label: t("common.copy"), disabled: !ctx.hasSelection },
    { id: "paste", label: t("common.paste"), separatorAfter: true },
    { id: "search", label: t("terminal.searchPlaceholder") },
    { id: "clear", label: t("terminal.clearScreen"), separatorAfter: true },
    {
      id: "splitRight",
      label: t("terminal.splitRight"),
    },
    { id: "splitDown", label: t("terminal.splitDown") },
    { id: "closePane", label: t("terminal.closePane"), danger: true, separatorAfter: true },
    {
      id: "encoding",
      label: t("terminal.encoding"),
      children: MENU_ENCODINGS.map((enc) => ({
        id: `encoding:${enc}`,
        label: enc.toUpperCase(),
        checked: ctx.encoding === enc,
      })),
    },
    { id: "copyOnSelect", label: t("terminal.copyOnSelect"), checked: ctx.copyOnSelect },
  ];
}

// --- 会话级终端设置（选择即复制 / 编码覆盖；localStorage 过渡，settings 表迁移点） ---

const SETTINGS_KEY = "ottr.settings.terminal";

export interface TerminalSettings {
  copyOnSelect: boolean;
}

const DEFAULT_SETTINGS: TerminalSettings = { copyOnSelect: false };

export function loadTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TerminalSettings>;
      if (typeof parsed.copyOnSelect === "boolean") {
        return { copyOnSelect: parsed.copyOnSelect };
      }
    }
  } catch {
    // 损坏/不可用 → 默认值
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveTerminalSettings(settings: TerminalSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 持久化失败不阻塞菜单
  }
}
