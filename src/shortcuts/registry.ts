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
// 【UI 批次一 Task 2 划界】顶栏「工具」菜单的条目**不是** ActionId，也刻意不
// 入本表：工作区族条目（总览/批量/端口转发/跳板链/定时任务/告警/MCP）是导航
// 动作（mainView 切换 / dock 面板开合），收口在 workspaceStore 的
// openMainView/openDock（见 workspace/workspaceStore.ts）；对话框族（凭据/AI/
// 同步）仍走 HomeLayout 就地 setState。本表（ActionId + 键位）零新增零删除——
// registry.test.ts（T14 守卫）原样锁定。
//
// 键位串法 = Tauri accelerator 子集：「CmdOrCtrl+Shift+D」；逗号等字面键直接
// 拼接（「CmdOrCtrl+,」）。展示与匹配都由本模块换算，外部永远不手写 ⌘/Ctrl。

export type Platform = "mac" | "win" | "linux";

/** 全部可从「非主机」入口触发的动作。面板命令、全局快捷键、汉堡菜单、
 * macOS 菜单（经事件回传）共用同一组 id。 */
export type ActionId =
  | "palette.toggle"
  | "history.search"
  | "hosts.new"
  | "settings.open"
  | "theme.toggle"
  | "lang.toggle"
  | "session.splitRight"
  | "session.splitDown"
  | "ai.nl2cmd"
  | "vault.lock"
  | "app.quit";

/** 每平台键位（mac 用 ⌘ 系，win/linux 用 Ctrl 系；无差异时三份同值）。
 * 平台项可缺省 = 该平台不注册全局键（仅面板/菜单可及）。 */
export interface KeysPerPlatform {
  mac?: string;
  win?: string;
  linux?: string;
}

export interface ActionDef {
  id: ActionId;
  /** i18n 词典键（zh-CN / en-US 双语齐全，i18n.test 守卫）。 */
  labelKey: string;
  /** 绑定键位；缺省 = 无全局键（仅面板/菜单可及）。 */
  keys?: KeysPerPlatform;
  /** 终端聚焦守卫候选标记（评审 M-4，fix round 1）：事件 target 在终端容器内
   * 时，只有「带此标记 **且** 键位带 Shift」的动作可被拦截（⌘K/⌘J 面板呼出键
   * 例外，见 terminalSafeHit）——终端第一公民是 Ctrl 系控制键（EOF = Ctrl+D），
   * 裸 Ctrl 系键位永不入表。防未来新增键重蹈「全局劫持终端输入」的覆辙。 */
  terminalSafe?: boolean;
}

/**
 * 动作总表（顺序 = 面板/汉堡菜单的展示顺序）。
 *
 * macOS 菜单镜像（src-tauri/src/menu.rs，改动需两侧同步 + 跑两侧测试）——
 * 只镜像 **mac 键位**（菜单是 mac 专属呈现；⌘ 系 chord 与终端 Ctrl 系控制键
 * 分属不同修饰键命名空间，不构成 EOF 劫持面）：
 *   palette.toggle = ⌘K   hosts.new = ⌘N   settings.open = ⌘,
 *   session.splitRight = ⌘D   session.splitDown = ⇧⌘D
 * history.search（⌘R）**刻意不进原生菜单**：AppKit 层的菜单 chord 先于 webview
 * 消费，会把「终端内 ⌘R 放行 PTY」的守卫语义整个击穿（菜单拦截不经过
 * matchActionEvent）——⌘R 只走前端全局监听 + 终端聚焦守卫。
 *
 * 【评审 M-4（fix round 1/5）：终端键位收敛】win/Linux 的分屏右**移除裸
 * Ctrl+D**（EOF 键是终端第一公民）收敛为仅 Ctrl+Shift+D；分屏下 win/linux
 * 不再注册全局键（面板/汉堡可及）——Ctrl+Shift+D 已被分屏右占用，不为分屏
 * 下的全局键发明新 Ctrl 系组合。mac 的 ⌘D/⇧⌘D 不动（⌘ 与 Ctrl 分属不同修饰键，
 * shell 的 Ctrl+D EOF 永远不经过菜单/全局监听，且终端聚焦守卫双保险，见下）。
 * app.quit 的 mac 键 ⌘Q 由原生菜单承担；win/linux 不装原生菜单，Alt+F4 是系统
 * 行为，面板里的「退出」走 app.exit。theme/lang/vault.lock 刻意无全局键：
 * 低频动作，面板 + 设置页足够（防键位蔓延）。
 */
export const ACTIONS: readonly ActionDef[] = [
  {
    id: "palette.toggle",
    labelKey: "palette.title",
    keys: { mac: "CmdOrCtrl+K", win: "Ctrl+K", linux: "Ctrl+K" },
    terminalSafe: true,
  },
  {
    // 【T15 终端聚焦守卫裁定】**不标 terminalSafe**——终端内 Ctrl+R 是 shell
    // 反向搜索（bash/zsh history-search-backward），⌘R 放行 PTY 是硬约束：
    // inTerminal 时 matchActionEvent 对本条返回 null（不拦截不 preventDefault），
    // 击键原样到 shell。⌘R 面板只在终端**不**聚焦时可由全局键呼出（⌘K 面板/
    // 汉堡菜单恒可及）。
    id: "history.search",
    labelKey: "history.title",
    keys: { mac: "CmdOrCtrl+R", win: "Ctrl+R", linux: "Ctrl+R" },
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
    keys: { mac: "CmdOrCtrl+D", win: "Ctrl+Shift+D", linux: "Ctrl+Shift+D" },
    terminalSafe: true,
  },
  {
    id: "session.splitDown",
    labelKey: "terminal.splitDown",
    keys: { mac: "CmdOrCtrl+Shift+D" },
    terminalSafe: true,
  },
  {
    // 【Phase 2 B1（Task 6）⌘J 裁定：全局直呼】NL→命令输入条是**呼出键**，
    // 与 ⌘K 同类（见 terminalSafeHit 例外）：终端聚焦时也命中——用户正盯着
    // 提示符想「这步该敲什么」，此刻恰恰要呼出。mac ⌘J 无终端冲突；win/linux
    // Ctrl+J 是 readline accept-line（= Enter），此处为裁定换取的劫持面，
    // 换来的是与 ⌘K 完全对称的「随处可呼」语义（代价已在评审记录挂账）。
    // 刻意不进 mac 原生菜单（同 history.search 教训：菜单 chord 绕过
    // matchActionEvent 守卫；本键恰恰要守卫放行，无菜单反而语义纯净）。
    id: "ai.nl2cmd",
    labelKey: "ai.nl2cmd.title",
    keys: { mac: "CmdOrCtrl+J", win: "Ctrl+J", linux: "Ctrl+J" },
    terminalSafe: true,
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

/** 按平台取动作键位（该平台未注册/无键位 → null）。 */
export function actionKeys(def: ActionDef, plat: Platform): string | null {
  return def.keys?.[plat] ?? null;
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

/** 遍历总表匹配键盘事件（全局监听入口）；命中返回 ActionId。
 * `inTerminal`（评审 M-4 终端聚焦守卫）：事件 target 在终端容器内时，只放行
 * 「terminalSafe 且键位带 Shift」的分屏键与 ⌘K/⌘J 面板呼出键例外，其余一律
 * null——调用方对 null 不 preventDefault，击键原样到达 PTY。mac ⌘D 不带 Shift
 * 故被前端守卫拦下：无碍——mac 菜单 chord 在 AppKit 层先于 webview 消费，
 * ⌘D 分屏走菜单路径。 */
export function matchActionEvent(
  e: KeyboardEvent,
  plat: Platform,
  inTerminal = false,
): ActionId | null {
  for (const def of ACTIONS) {
    const accel = actionKeys(def, plat);
    if (accel && matchesAccelerator(e, accel)) {
      if (inTerminal && !terminalSafeHit(def, accel)) return null;
      return def.id;
    }
  }
  return null;
}

/** 终端内放行判定：terminalSafe 标记 + 键位带 Shift（⌘K/⌘J 面板呼出键例外）。
 * 双条件缺一不可——标记防新增裸 Ctrl 键重蹈覆辙，Shift 条件把「带 Shift 的
 * 分屏键」语义钉在数据上而非注释里；palette.toggle / ai.nl2cmd 是唯一的
 * 无 Shift 例外：呼出键必须随处可及（终端内恰恰是主使用场景）。 */
function terminalSafeHit(def: ActionDef, accel: string): boolean {
  if (!def.terminalSafe) return false;
  return (
    parseAccelerator(accel).shift ||
    def.id === "palette.toggle" ||
    def.id === "ai.nl2cmd"
  );
}

/** 终端聚焦判定（App 全局监听用）：事件 target 落在 `[data-terminal]` 容器内。
 * 非 Element target（window/document 直发）返回 false——守卫只针对真实终端面。 */
export function isTerminalTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return typeof el?.closest === "function" && el.closest("[data-terminal]") !== null;
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
