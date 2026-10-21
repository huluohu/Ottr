// shortcut / action registry（A12，Task 14）：一处定义，多入口引用。
//
// spec §13 纪律：「所有快捷键走统一 shortcut registry（一处定义、菜单/面板/提示
// 三处引用）」。本表是前端的唯一权威——
//   * 全局键盘监听（App）：ACTIONS[].keys 逐条 match；
//   * 命令面板（palette/CommandPalette）：命令条目 = ACTIONS + 主机，标签取
//     labelKey、键位提示取 shortcutLabel()；
//   * Win/Linux 汉堡菜单（titlebar/TitleBar）：同一张 ACTIONS 渲染；
//   * macOS 原生菜单（desktop/src/menu.rs menu_tree()）：**镜像**本表带键位的
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
  | "local.terminal"
  | "settings.open"
  | "theme.toggle"
  | "lang.toggle"
  | "session.splitRight"
  | "session.splitDown"
  | "ai.nl2cmd"
  | "vault.lock"
  | "hosts.new_group"
  | "hosts.import"
  | "hosts.export"
  | "notify.center"
  | "hosts.panelToggle"
  | "session.tabNext"
  | "session.tabPrev"
  | "app.quit"
  | "app.closeWindow"
  | "app.toggleFullscreen"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset";

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
 * macOS 菜单镜像（desktop/src/menu.rs，改动需两侧同步 + 跑两侧测试）——
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
  // 本地终端（2026-10-20）：⌘K 可达的第二个入口（第一入口 = 图标轨 rail-local）。
  { id: "local.terminal", labelKey: "nav.localTerminal" },
  // 新建分组（2026-10-08 菜单栏启用批次）：File 菜单/汉堡可及（无快捷键——
  // ⌘G 是浏览器查找下一语义，不抢占）；App 直派 HostTree 分组态。
  { id: "hosts.new_group", labelKey: "hostTree.addGroup" },
  // 导入主机配置（2026-10-10 IA：自侧栏工具区移除，安家 文件菜单/⌘K/欢迎页卡）
  { id: "hosts.import", labelKey: "importDialog.title" },
  // 导出主机（2026-10-19 用户裁定：导入导出归文件菜单——hosts.import 对称位；
  // 工具清单同名条目同批退役，⌘K/汉堡经本条可达）
  { id: "hosts.export", labelKey: "tools.exportHosts" },
  // 通知中心（工具族）：mac 原生工具菜单 + win/linux 汉堡同源入口。
  { id: "notify.center", labelKey: "notify.centerTitle" },
  // 主机面板折叠胶囊（2026-10-16 视觉重设计 M3「獭居·浮岛」）：⌘\ 一键把
  // 主机面板折成 64px 悬浮胶囊。win/linux 不用裸 Ctrl+\（SIGQUIT 是终端
  // 控制键）收敛为 Ctrl+Shift+\（带 Shift 满足终端守卫）；mac ⌘\ 走
  // terminalSafeHit 呼出键例外（同 ⌘K 语义：布局开关必须随处可及）。
  {
    id: "hosts.panelToggle",
    labelKey: "palette.sidebarCollapse",
    keys: { mac: "CmdOrCtrl+\\", win: "Ctrl+Shift+\\", linux: "Ctrl+Shift+\\" },
    terminalSafe: true,
  },
  { id: "app.quit", labelKey: "palette.quit" },
  // --- 2026-10-12 跨平台审计补齐（此前 Win/Linux 整体不可达的 mac-only 面）---
  {
    // 关窗键：mac ⌘W 由原生菜单 Predef::CloseWindow 承担；win/linux 用
    // Ctrl+Shift+W（带 Shift 满足终端守卫——裸 Ctrl+W 是 shell 删词，禁抢）。
    // 动作 = window.close()，与点标题栏 X 同路（close-to-tray 拦截转隐藏）。
    id: "app.closeWindow",
    labelKey: "menu.closeWindow",
    keys: { win: "Ctrl+Shift+W", linux: "Ctrl+Shift+W" },
    terminalSafe: true,
  },
  {
    // 全屏切换：F11（win/linux 惯例）。不标 terminalSafe——终端聚焦时 F11
    // 原样放行 PTY（远端程序自会处理），与 history.search 同一守卫口径。
    id: "app.toggleFullscreen",
    labelKey: "menu.fullscreen",
    keys: { win: "F11", linux: "F11" },
  },
  // 缩放三键（2026-10-12 跨平台审计）：mac 视图菜单 ⌘=/⌘-/⌘0（menu.rs
  // view.zoom*）是此前唯一入口——Win/Linux 既无原生菜单也无键位，缩放整体
  // 不可达。键位走浏览器惯例 Ctrl+=/Ctrl+-/Ctrl+0；mac 不注册全局键（原生
  // 菜单 chord 拥有 ⌘ 系，全局监听不重复承接）。三端 palette/汉堡经
  // handleAction → invoke("view_zoom") 进 menu.rs apply_zoom——与 mac 菜单
  // 共用 ZoomState 单一状态源。不标 terminalSafe：终端聚焦时放行 PTY（同
  // F11 口径，Ctrl 系数字/符号非 shell 关键键但守卫纪律优先）。
  { id: "view.zoomIn", labelKey: "menu.zoomIn", keys: { win: "Ctrl+=", linux: "Ctrl+=" } },
  { id: "view.zoomOut", labelKey: "menu.zoomOut", keys: { win: "Ctrl+-", linux: "Ctrl+-" } },
  { id: "view.zoomReset", labelKey: "menu.zoomReset", keys: { win: "Ctrl+0", linux: "Ctrl+0" } },
  // 标签切换（2026-10-18 入口审计缺口补齐）：Ctrl+Tab / Ctrl+Shift+Tab 是
  // 窗口级页签惯例，非 shell 控制键；刻意不标 terminalSafe——终端聚焦时
  // 击键原样放行 PTY（同 ⌘R/F11 守卫口径，远端程序自会处理），面板/汉堡
  // 恒可及。mac 无全局键惯例冲突（⌘Tab 是系统应用切换器，不注册）。
  {
    id: "session.tabNext",
    labelKey: "tabs.nextTab",
    keys: { mac: "Ctrl+Tab", win: "Ctrl+Tab", linux: "Ctrl+Tab" },
  },
  {
    id: "session.tabPrev",
    labelKey: "tabs.prevTab",
    keys: { mac: "Ctrl+Shift+Tab", win: "Ctrl+Shift+Tab", linux: "Ctrl+Shift+Tab" },
  },
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
  const accel = def ? effectiveAccel(def, plat) : null;
  return accel ? formatAccelerator(accel, plat) : null;
}

// --- 键位覆盖（2026-10-21 快捷键改键设置）-------------------------------------
// 覆盖表：动作 id → 加速串（平台中性，CmdOrCtrl 三平台同语义）。**空 = 出厂
// 键位**，匹配/提示/菜单走的分支与无覆盖时逐字节一致；设置→快捷键写，App
// 启动装载（装载完成前走默认值，无空窗态）。错误恢复纪律：装载逐条校验，
// 坏条目单条丢弃（store 侧），本层只信拿到的表。

export type OverrideMap = Partial<Record<ActionId, string>>;

let OVERRIDES: OverrideMap = {};
let overridesVersionCounter = 0;
const overridesListeners = new Set<() => void>();

/** 应用覆盖表（整表替换；调用方负责先校验与持久化）。 */
export function applyOverrides(map: OverrideMap): void {
  OVERRIDES = { ...map };
  overridesVersionCounter += 1;
  for (const fn of overridesListeners) fn();
}

/** 覆盖表快照（只读副本；设置页展示/同步面）。 */
export function overridesSnapshot(): OverrideMap {
  return { ...OVERRIDES };
}

/** 版本号（每次应用 +1）：提示组件订阅它以在覆盖变化时重渲染。 */
export function overridesVersion(): number {
  return overridesVersionCounter;
}

/** 订阅覆盖变化（useSyncExternalStore 消费面）。 */
export function subscribeOverrides(fn: () => void): () => void {
  overridesListeners.add(fn);
  return () => {
    overridesListeners.delete(fn);
  };
}

/** 生效键位 = 覆盖优先、缺省兜底（该平台未注册 → null）。 */
function effectiveAccel(def: ActionDef, plat: Platform): string | null {
  return OVERRIDES[def.id] ?? actionKeys(def, plat);
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
  // Shift+符号键的 e.key 是移位后的字形（US 布局：Shift+\ = "|"，真机 E2E
  // 2026-10-16 实证 Ctrl+Shift+\ 永不命中）——按别名归一后再比对。别名只收
  // 本表用到的移位字形；新增 Shift 系符号键位时在此补表。
  const SHIFTED_KEY_ALIASES: Record<string, string> = { "|": "\\" };
  const actual = SHIFTED_KEY_ALIASES[e.key]?.toLowerCase() ?? e.key.toLowerCase();
  return actual === p.key;
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
    const accel = effectiveAccel(def, plat);
    if (accel && matchesAccelerator(e, accel)) {
      if (inTerminal && !terminalSafeHit(def, accel)) return null;
      return def.id;
    }
  }
  return null;
}

/** 终端内放行判定：terminalSafe 标记 + 键位带 Shift（⌘K/⌘J/⌘\ 呼出键例外）。
 * 双条件缺一不可——标记防新增裸 Ctrl 键重蹈覆辙，Shift 条件把「带 Shift 的
 * 分屏键」语义钉在数据上而非注释里；palette.toggle / ai.nl2cmd /
 * hosts.panelToggle 是仅有的无 Shift 例外：呼出/布局开关必须随处可及
 * （终端内恰恰是主使用场景；win/linux 的 hosts.panelToggle 本就带 Shift）。 */
function terminalSafeHit(def: ActionDef, accel: string): boolean {
  if (!def.terminalSafe) return false;
  return (
    parseAccelerator(accel).shift ||
    def.id === "palette.toggle" ||
    def.id === "ai.nl2cmd" ||
    def.id === "hosts.panelToggle"
  );
}

/** 终端聚焦判定（App 全局监听用）：事件 target 落在 `[data-terminal]` 容器内。
 * 非 Element target（window/document 直发）返回 false——守卫只针对真实终端面。 */
export function isTerminalTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return typeof el?.closest === "function" && el.closest("[data-terminal]") !== null;
}

// --- 开发期冲突检测 -----------------------------------------------------------

/** 同平台下同键位被多个动作绑定 → 返回冲突描述（空 = 无冲突）。纯函数，测试直测。
 * `overrides`（改键设置草稿/生效表）：冲突按「覆盖优先」的生效键位计算。 */
export function findConflicts(plat: Platform, overrides: OverrideMap = {}): string[] {
  const byKey = new Map<string, string[]>();
  for (const def of ACTIONS) {
    const accel = overrides[def.id] ?? actionKeys(def, plat);
    if (!accel) continue;
    const norm = accel.split("+").map((p) => p.trim().toLowerCase()).sort().join("+");
    byKey.set(norm, [...(byKey.get(norm) ?? []), def.id]);
  }
  return [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([norm, ids]) => `${plat}: ${norm} -> ${ids.join(", ")}`);
}

/** 生效键位（覆盖优先）的冲突分组（改键设置校验面）：同平台同键位被 ≥2 个
 * 动作绑定时返回这些动作 id 的分组；空 = 无冲突。纯函数，测试直测。 */
export function findConflictGroups(
  overrides: OverrideMap,
  plat: Platform,
): ActionId[][] {
  const byKey = new Map<string, ActionId[]>();
  for (const def of ACTIONS) {
    const accel = overrides[def.id] ?? actionKeys(def, plat);
    if (!accel) continue;
    const norm = accel
      .split("+")
      .map((p) => p.trim().toLowerCase())
      .sort()
      .join("+");
    byKey.set(norm, [...(byKey.get(norm) ?? []), def.id]);
  }
  return [...byKey.values()].filter((ids) => ids.length > 1);
}

/** 开发期哨兵（import.meta.env.DEV；构建期零开销）。 */
export function warnShortcutConflicts(): void {
  if (import.meta.env.DEV) {
    for (const c of (["mac", "win", "linux"] as const).flatMap((plat) => findConflicts(plat))) {
      console.warn(`[shortcuts] conflict: ${c}`);
    }
  }
}
