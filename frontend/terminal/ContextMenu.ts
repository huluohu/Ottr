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
  /** 智能补全开关（Task 8 B8；Tab 驱动，无快捷键）。 */
  completionEnabled: boolean;
  /** 当前会话编码覆盖（"" = 未设置）。 */
  encoding: string;
  /** 分屏已达上限（2026-10-21）：分屏两项置灰（守卫本体在 splitPane）。 */
  splitDisabled?: boolean;
}

/**
 * 菜单模型（简报：复制/粘贴/搜索/清屏/编码子菜单 + 分屏/选择即复制）。
 * id 一览：copy paste search clear encoding?（含子菜单）splitRight splitDown
 * closePane copyOnSelect completion。
 */
export function buildContextMenu(ctx: MenuContext, t: TFunction): ContextMenuItem[] {
  return [
    { id: "copy", label: t("common.copy"), disabled: !ctx.hasSelection },
    { id: "explain", label: t("ai.menuExplain"), disabled: !ctx.hasSelection, separatorAfter: true },
    { id: "paste", label: t("common.paste"), separatorAfter: true },
    { id: "search", label: t("terminal.searchPlaceholder") },
    { id: "clear", label: t("terminal.clearScreen"), separatorAfter: true },
    {
      id: "splitRight",
      label: t("terminal.splitRight"),
      disabled: ctx.splitDisabled === true,
    },
    { id: "splitDown", label: t("terminal.splitDown"), disabled: ctx.splitDisabled === true },
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
    { id: "completion", label: t("terminal.completion"), checked: ctx.completionEnabled },
  ];
}

// --- 会话级终端设置（选择即复制/智能补全 / 编码覆盖；localStorage 过渡，settings 表迁移点） ---

const SETTINGS_KEY = "ottr.settings.terminal";

/** 终端默认字体栈（用户未选字体时使用；2026-10-10 用户反馈 xterm 缺省
 * Courier New 太丑）：macOS 落 SF Mono / ui-monospace，Win 落 Consolas，
 * Linux 落 Cascadia/JetBrains/Liberation，末位兜底泛 monospace。 */
export const DEFAULT_TERMINAL_FONT_FAMILY =
  'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", "JetBrains Mono", Consolas, "Liberation Mono", "Courier New", monospace';

export interface TerminalSettings {
  copyOnSelect: boolean;
  /** 智能补全（Task 8 B8）：默认开（简报裁定 completion.enabled 默认 true）。 */
  completionEnabled: boolean;
  /** 终端字体族（null = xterm 默认栈；2026-10-09 设置页字体/字号项）。 */
  fontFamily: string | null;
  /** 终端字号（null = 13 默认）。 */
  fontSize: number | null;
  /** 读屏模式（2026-11 性能审计改设置项，**默认关**）：此前对所有用户无条件
   *  常开——xterm 在 print 内层循环逐码点发 a11y 事件，输出洪流场景仅此一项
   *  可烧 0.3–1 核（所有用户为读屏用户付常态税）。读屏用户在设置页开启后
   *  xterm 才把缓冲区暴露成可读 DOM。 */
  screenReaderMode: boolean;
}

const DEFAULT_SETTINGS: TerminalSettings = {
  copyOnSelect: false,
  completionEnabled: true,
  fontFamily: null,
  fontSize: null,
  screenReaderMode: false,
};

/** 终端设置的模块级缓存（击键热路径读；失效点见 loadTerminalSettings 注释）。
 *  `cachedRaw` = 上次解析所依据的 localStorage 原文——**按原文键控**：
 *  任何写入面（含直接写 localStorage 的路径）只要原文变了就重新解析，
 *  不会读到过期值。 */
let cachedRaw: string | null = null;
let cachedSettings: TerminalSettings | null = null;

export function loadTerminalSettings(): TerminalSettings {
  // 模块级缓存（2026-11-20 性能审计 P3）：本函数在**击键热路径**上被调用
  // （ghost 补全的 enabled 判定、选择即复制回调）——每次 JSON.parse 在高频
  // 路径上是纯浪费。缓存**按 localStorage 原文键控**：原文未变即复用解析
  // 结果，原文变了（任何写入面）即重解析——既省掉热路径的解析开销，又不会
  // 读到过期值（不依赖「谁负责失效」这类约定）。
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    raw = null;
  }
  if (cachedSettings !== null && raw === cachedRaw) {
    // 返回浅拷贝：调用方若就地改字段不会污染缓存（与「每次返回新对象」的
    // 旧语义一致）。
    return { ...cachedSettings };
  }
  cachedRaw = raw;
  cachedSettings = parseTerminalSettings(raw);
  return { ...cachedSettings };
}

function parseTerminalSettings(raw: string | null): TerminalSettings {
  try {
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TerminalSettings>;
      // 字段独立回退（旧存量只有 copyOnSelect）：缺省各自落默认值
      return {
        copyOnSelect:
          typeof parsed.copyOnSelect === "boolean" ? parsed.copyOnSelect : DEFAULT_SETTINGS.copyOnSelect,
        completionEnabled:
          typeof parsed.completionEnabled === "boolean"
            ? parsed.completionEnabled
            : DEFAULT_SETTINGS.completionEnabled,
        fontFamily:
          typeof parsed.fontFamily === "string" ? parsed.fontFamily : DEFAULT_SETTINGS.fontFamily,
        fontSize: typeof parsed.fontSize === "number" ? parsed.fontSize : DEFAULT_SETTINGS.fontSize,
        screenReaderMode:
          typeof parsed.screenReaderMode === "boolean"
            ? parsed.screenReaderMode
            : DEFAULT_SETTINGS.screenReaderMode,
      };
    }
  } catch {
    // 损坏/不可用 → 默认值
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveTerminalSettings(settings: TerminalSettings): void {
  const raw = JSON.stringify(settings);
  try {
    localStorage.setItem(SETTINGS_KEY, raw);
  } catch {
    // 持久化失败不阻塞菜单
  }
  // 写入即刷新缓存（下次读按原文命中，无需重解析）。
  cachedRaw = raw;
  cachedSettings = settings;
}
