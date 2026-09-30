// shortcut / action registry（A12，Task 14）：一处定义，多入口引用。
//
// spec §13 纪律：「所有快捷键走统一 shortcut registry（一处定义、菜单/面板/提示
// 三处引用）」。本表是前端的唯一权威——
//   * 全局键盘监听（App）：ACTIONS[].keys 逐条 match；
//   * 命令面板（palette/CommandPalette）：命令条目 = ACTIONS + 主机，标签取
//     labelKey、键位提示取 shortcutLabel()；
//   * Win/Linux 汉堡菜单（titlebar/TitleBar）：同一张 ACTIONS 渲染；
//   * macOS 原生菜单（src-tauri/src/menu.rs menu_tree()）：**镜像**本表带键位的
//     条目（Rust 侧无法 import TS，两侧各有一份字面量；下方 MAC_MENU_MIRRORED
//     测试把镜像值钉死，改动键位需两侧同步，否则测试红）。
// Rust 菜单/托盘的动作回传走 `ottr://menu-action` 事件（载荷 = ActionId 字符串），
// 前端 dispatch 进同一个 handleAction——一处 action 多入口的收口在 App.tsx。
//
// 键位串法 = Tauri accelerator 子集：「CmdOrCtrl+Shift+D」；逗号等字面键直接
// 拼接（「CmdOrCtrl+,」）。展示与匹配都由本模块换算，外部永远不手写 ⌘/Ctrl。

export type Platform = "mac" | "win" | "linux";

/** 全部可从「非主机」入口触发的动作。面板命令、全局快捷键、汉堡菜单、
 * macOS 菜单（经事件回传）共用同一组 id。 */
export type ActionId =
  | "palette.toggle"
  | "hosts.new"
  | "settings.open"
  | "theme.toggle"
  | "lang.toggle"
  | "session.splitRight"
  | "session.splitDown"
  | "vault.lock"
  | "app.quit";

/** 每平台键位（mac 用 ⌘ 系，win/linux 用 Ctrl 系；无差异时三份同值）。 */
export interface KeysPerPlatform {
  mac: string;
  win: string;
  linux: string;
}

export interface ActionDef {
  id: ActionId;
  /** i18n 词典键（zh-CN / en-US 双语齐全，i18n.test 守卫）。 */
  labelKey: string;
  /** 绑定键位；缺省 = 无全局键（仅面板/菜单可及）。 */
  keys?: KeysPerPlatform;
}

/**
 * 动作总表（顺序 = 面板/汉堡菜单的展示顺序）。
 *
 * macOS 菜单镜像（src-tauri/src/menu.rs，改动需两侧同步 + 跑两侧测试）：
 *   palette.toggle = CmdOrCtrl+K   hosts.new = CmdOrCtrl+N
 *   settings.open  = CmdOrCtrl+,   session.splitRight = CmdOrCtrl+D
 *   session.splitDown = CmdOrCtrl+Shift+D
 * app.quit 的 mac 键 ⌘Q 由原生菜单 PredefinedMenuItem/自定义项承担；
 * win/linux 不装原生菜单，Alt+F4 是系统行为，面板里的「退出」走 app.exit。
 * theme/lang/vault.lock 刻意无全局键：低频动作，面板 + 设置页足够（防键位蔓延）。
 */
export const ACTIONS: readonly ActionDef[] = [
  {
    id: "palette.toggle",
    labelKey: "palette.title",
    keys: { mac: "CmdOrCtrl+K", win: "Ctrl+K", linux: "Ctrl+K" },
  },
  {
    id: "hosts.new",
    labelKey: "palette.newHost",
    keys: { mac: "CmdOrCtrl+N", win: "Ctrl+N", linux: "Ctrl+N" },
  },
  {
    id: "settings.open",
    labelKey: "settings.title",
    keys: { mac: "CmdOrCtrl+,", win: "Ctrl+,", linux: "Ctrl+," },
  },
  { id: "theme.toggle", labelKey: "palette.themeToggle" },
  { id: "lang.toggle", labelKey: "palette.langToggle" },
  {
    id: "session.splitRight",
    labelKey: "terminal.splitRight",
    keys: { mac: "CmdOrCtrl+D", win: "Ctrl+D", linux: "Ctrl+D" },
  },
  {
    id: "session.splitDown",
    labelKey: "terminal.splitDown",
    keys: { mac: "CmdOrCtrl+Shift+D", win: "Ctrl+Shift+D", linux: "Ctrl+Shift+D" },
  },
  { id: "vault.lock", labelKey: "security.lockNow" },
  { id: "app.quit", labelKey: "palette.quit" },
];

/** 平台判定（Navigator.userAgent；jsdom 默认走 win 分支，测试可 stub）。 */
export function platform(ua: string = navigator.userAgent): Platform {
  if (/Mac|iPhone|iPad/i.test(ua)) return "mac";
  if (/Linux|X11|FreeBSD/i.test(ua)) return "linux";
  return "win";
}

/** 按平台取动作键位（无键位 → null）。 */
export function actionKeys(def: ActionDef, plat: Platform): string | null {
  return def.keys ? (def.keys[plat] ?? null) : null;
}

const MAC_SYMBOLS: Record<string, string> = {
  CmdOrCtrl: "⌘",
  Ctrl: "⌃",
  Shift: "⇧",
  Alt: "⌥",
};

/** accelerator → 平台展示串（快捷键提示）：
 * mac「CmdOrCtrl+Shift+D」→「⌘⇧D」；win/linux →「Ctrl+Shift+D」。
 * 总表 win/linux 字面量直接写「Ctrl+…」（平台差异留Alt/F 系表达空间），
 * 与「CmdOrCtrl+…」等价对待。 */
export function formatAccelerator(accel: string, plat: Platform): string {
  const parts = accel.split("+").map((p) => p.trim());
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    if (p === "CmdOrCtrl" || p === "Ctrl" || p === "Shift" || p === "Alt") mods.push(p);
    else key = p;
  }
  if (plat === "mac") {
    return mods.map((m) => MAC_SYMBOLS[m]).join("") + key;
  }
  const winMods = mods.map((m) => (m === "CmdOrCtrl" ? "Ctrl" : m));
  return [...winMods, key].join("+");
}

/** id → 平台展示串（「⌘K」/「Ctrl+K」；无键位 → null）。提示三处引用的出口。 */
export function shortcutLabel(id: ActionId, plat: Platform): string | null {
  const def = ACTIONS.find((a) => a.id === id);
  const accel = def ? actionKeys(def, plat) : null;
  return accel ? formatAccelerator(accel, plat) : null;
}

// --- 键盘事件匹配 -------------------------------------------------------------

interface ParsedAccel {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** 解析 accelerator（只支持本表用到的子集：CmdOrCtrl/Ctrl/Shift/Alt + 字面键；
 * CmdOrCtrl 与 Ctrl 同义——表内 win/linux 字面量直接写 Ctrl）。 */
function parseAccelerator(accel: string): ParsedAccel {
  const parsed: ParsedAccel = { ctrl: false, shift: false, alt: false, key: "" };
  for (const part of accel.split("+").map((p) => p.trim())) {
    if (part === "CmdOrCtrl" || part === "Ctrl") parsed.ctrl = true;
    else if (part === "Shift") parsed.shift = true;
    else if (part === "Alt") parsed.alt = true;
    else parsed.key = part.toLowerCase();
  }
  return parsed;
}

/** KeyboardEvent 是否命中 accelerator。字母键大小写宽容（CapsLock 不破坏匹配）。 */
export function matchesAccelerator(e: KeyboardEvent, accel: string): boolean {
  const p = parseAccelerator(accel);
  if (!p.key) return false;
  // CmdOrCtrl = ⌘（metaKey）或 Ctrl 皆可命中（mac 用户两种习惯都照顾）；
  // 反向也成立：无 Ctrl 修饰的动作（当前表里没有）不会在 ⌘ 按下时误触。
  // ⌘+字母在 mac 会把 e.key 抬成大写，统一按 toLowerCase 比对。
  if (p.ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (e.shiftKey !== p.shift) return false;
  if (e.altKey !== p.alt) return false;
  return e.key.toLowerCase() === p.key;
}

/** 遍历总表匹配键盘事件（全局监听入口）；命中返回 ActionId。 */
export function matchActionEvent(e: KeyboardEvent, plat: Platform): ActionId | null {
  for (const def of ACTIONS) {
    const accel = actionKeys(def, plat);
    if (accel && matchesAccelerator(e, accel)) return def.id;
  }
  return null;
}

// --- 开发期冲突检测 -----------------------------------------------------------

/** 同平台下同键位被多个动作绑定 → 返回冲突描述（空 = 无冲突）。纯函数，测试直测。 */
export function findConflicts(plat: Platform): string[] {
  const byKey = new Map<string, string[]>();
  for (const def of ACTIONS) {
    const accel = actionKeys(def, plat);
    if (!accel) continue;
    const norm = accel.split("+").map((p) => p.trim().toLowerCase()).sort().join("+");
    byKey.set(norm, [...(byKey.get(norm) ?? []), def.id]);
  }
  return [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([norm, ids]) => `${plat}: ${norm} -> ${ids.join(", ")}`);
}

/** 开发期哨兵（import.meta.env.DEV；构建期零开销）。 */
export function warnShortcutConflicts(): void {
  if (import.meta.env.DEV) {
    for (const c of (["mac", "win", "linux"] as const).flatMap(findConflicts)) {
      console.warn(`[shortcuts] conflict: ${c}`);
    }
  }
}
