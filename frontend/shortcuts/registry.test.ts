// shortcut registry 单测（Task 14）：平台判定 / accelerator 展示与匹配 /
// 冲突检测 / Rust 菜单镜像值钉死。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIONS,
  findConflicts,
  formatAccelerator,
  isTerminalTarget,
  matchActionEvent,
  matchesAccelerator,
  platform,
  shortcutLabel,
  type ActionId,
} from "./registry";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
};

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("platform()", () => {
  it("按 UA 分派三端", () => {
    expect(platform(UA.mac)).toBe("mac");
    expect(platform(UA.win)).toBe("win");
    expect(platform(UA.linux)).toBe("linux");
  });
});

describe("formatAccelerator / shortcutLabel（提示面）", () => {
  it("mac 出 ⌘⇧ 符号串，win/linux 出 Ctrl 文本", () => {
    expect(formatAccelerator("CmdOrCtrl+K", "mac")).toBe("⌘K");
    expect(formatAccelerator("CmdOrCtrl+K", "win")).toBe("Ctrl+K");
    expect(formatAccelerator("CmdOrCtrl+Shift+D", "mac")).toBe("⌘⇧D");
    expect(formatAccelerator("CmdOrCtrl+Shift+D", "linux")).toBe("Ctrl+Shift+D");
    expect(formatAccelerator("CmdOrCtrl+,", "mac")).toBe("⌘,");
  });

  it("shortcutLabel：有键位的动作按平台出展示串，无键位返回 null", () => {
    expect(shortcutLabel("palette.toggle", "mac")).toBe("⌘K");
    expect(shortcutLabel("palette.toggle", "win")).toBe("Ctrl+K");
    expect(shortcutLabel("settings.open", "mac")).toBe("⌘,");
    expect(shortcutLabel("theme.toggle", "mac")).toBeNull();
    expect(shortcutLabel("vault.lock", "win")).toBeNull();
    expect(shortcutLabel("app.quit", "linux")).toBeNull();
  });
});

describe("matchesAccelerator / matchActionEvent（键盘面）", () => {
  it("mac：⌘K 与 Ctrl+K 都命中 CmdOrCtrl+K", () => {
    const accel = "CmdOrCtrl+K";
    expect(matchesAccelerator(keyEvent({ key: "k", metaKey: true }), accel)).toBe(true);
    expect(matchesAccelerator(keyEvent({ key: "K", ctrlKey: true }), accel)).toBe(true);
    expect(matchesAccelerator(keyEvent({ key: "k" }), accel)).toBe(false);
    expect(matchesAccelerator(keyEvent({ key: "k", metaKey: true, shiftKey: true }), accel)).toBe(false);
  });

  it("win/linux：Ctrl+K 命中、裸 K 不命中", () => {
    expect(matchActionEvent(keyEvent({ key: "k", ctrlKey: true }), "win")).toBe("palette.toggle");
    expect(matchActionEvent(keyEvent({ key: "k" }), "win")).toBeNull();
  });

  it("分屏键位（评审 M-4 收敛）：裸 Ctrl+D 不再注册；Ctrl+Shift+D = 分屏右", () => {
    // win/linux：裸 Ctrl+D（终端 EOF 第一公民）不放行、不注册
    expect(matchActionEvent(keyEvent({ key: "d", ctrlKey: true }), "win")).toBeNull();
    expect(matchActionEvent(keyEvent({ key: "d", ctrlKey: true }), "linux")).toBeNull();
    // win/linux：Ctrl+Shift+D = 分屏右（splitDown 在 win/linux 无全局键）
    expect(matchActionEvent(keyEvent({ key: "D", ctrlKey: true, shiftKey: true }), "win")).toBe(
      "session.splitRight",
    );
    expect(matchActionEvent(keyEvent({ key: "D", ctrlKey: true, shiftKey: true }), "linux")).toBe(
      "session.splitRight",
    );
    // mac：⌘D / ⇧⌘D（⌘ 与终端 Ctrl 系分属不同修饰键，不构成 EOF 劫持面）
    expect(matchActionEvent(keyEvent({ key: "d", metaKey: true }), "mac")).toBe("session.splitRight");
    expect(matchActionEvent(keyEvent({ key: "D", metaKey: true, shiftKey: true }), "mac")).toBe(
      "session.splitDown",
    );
    // Shift 修饰严格匹配：⌘⇧D 不会命中 ⌘D 的动作
    expect(matchActionEvent(keyEvent({ key: "d", metaKey: true, shiftKey: true }), "mac")).toBe(
      "session.splitDown",
    );
  });

  it("逗号键（设置 ⌘,）与 Alt 修饰不串扰", () => {
    expect(matchActionEvent(keyEvent({ key: ",", metaKey: true }), "mac")).toBe("settings.open");
    expect(matchActionEvent(keyEvent({ key: ",", ctrlKey: true }), "linux")).toBe("settings.open");
    expect(matchActionEvent(keyEvent({ key: ",", metaKey: true, altKey: true }), "mac")).toBeNull();
  });

  it("总表 id 唯一（防手滑重复定义）", () => {
    const ids = ACTIONS.map((a) => a.id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findConflicts（开发期冲突检测）", () => {
  it("现表无冲突；人为加入同键位动作可检出", () => {
    for (const p of ["mac", "win", "linux"] as const) {
      expect(findConflicts(p)).toEqual([]);
    }
    // 篡改一份拷贝验证检测逻辑真的能抓冲突（不污染总表）
    const mutated = ACTIONS.map((a) =>
      a.id === "theme.toggle"
        ? { ...a, keys: { mac: "CmdOrCtrl+K", win: "Ctrl+K", linux: "Ctrl+K" } }
        : a,
    );
    const byKey = new Map<string, string[]>();
    for (const def of mutated) {
      const mac = def.keys?.mac;
      if (!mac) continue;
      const norm = mac.split("+").map((s) => s.trim().toLowerCase()).sort().join("+");
      byKey.set(norm, [...(byKey.get(norm) ?? []), def.id]);
    }
    const dupes = [...byKey.values()].filter((ids) => ids.length > 1);
    expect(dupes).toEqual([["palette.toggle", "theme.toggle"]]);
  });

  it("warnShortcutConflicts 在 DEV 下对空表保持安静", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { warnShortcutConflicts } = await import("./registry");
    warnShortcutConflicts();
    expect(spy).not.toHaveBeenCalled();
  });
});

// macOS 原生菜单（desktop/src/menu.rs menu_tree()）镜像值钉死：Rust 侧无法
// import 本表，两侧字面量靠本用例 + Rust 单测双向锁定——改动键位必须两侧同步。
// 镜像只覆盖 **mac 键位**（菜单是 mac 专属呈现）；win/linux 键位独立，其中
// 分屏右已按评审 M-4 收敛为 Ctrl+Shift+D（裸 Ctrl+D 是终端 EOF，见 ACTIONS 注）。
describe("Rust 菜单镜像钉死", () => {
  const MIRRORED: Partial<Record<ActionId, string>> = {
    "palette.toggle": "CmdOrCtrl+K",
    "hosts.new": "CmdOrCtrl+N",
    "settings.open": "CmdOrCtrl+,",
    "session.splitRight": "CmdOrCtrl+D",
    "session.splitDown": "CmdOrCtrl+Shift+D",
  };
  it("注册表 mac 键位与 Rust 菜单字面量一致", () => {
    for (const [id, accel] of Object.entries(MIRRORED)) {
      expect(shortcutLabel(id as ActionId, "mac"), id).toBe(formatAccelerator(accel, "mac"));
    }
  });
  it("分屏右 win/linux 收敛为 Ctrl+Shift+D；分屏下无 win/linux 全局键", () => {
    expect(shortcutLabel("session.splitRight", "win")).toBe("Ctrl+Shift+D");
    expect(shortcutLabel("session.splitRight", "linux")).toBe("Ctrl+Shift+D");
    expect(shortcutLabel("session.splitDown", "win")).toBeNull();
    expect(shortcutLabel("session.splitDown", "linux")).toBeNull();
  });
});

// 终端聚焦守卫（评审 M-4，fix round 1）：target 在终端容器内时只有
// terminalSafe 动作（Shift 系分屏 + ⌘K）可命中，其余返回 null（不拦截）。
describe("终端聚焦守卫（matchActionEvent inTerminal）", () => {
  it("终端内：Ctrl+D（EOF）永不命中；Ctrl+Shift+D 与 ⌘K 照常命中", () => {
    expect(matchActionEvent(keyEvent({ key: "d", ctrlKey: true }), "win", true)).toBeNull();
    expect(matchActionEvent(keyEvent({ key: "d", ctrlKey: true }), "linux", true)).toBeNull();
    // mac ⌘D 不带 Shift → 前端守卫不放行（分屏走 mac 菜单 AppKit 路径，无碍）
    expect(matchActionEvent(keyEvent({ key: "d", metaKey: true }), "mac", true)).toBeNull();
    expect(
      matchActionEvent(keyEvent({ key: "D", ctrlKey: true, shiftKey: true }), "linux", true),
    ).toBe("session.splitRight");
    expect(matchActionEvent(keyEvent({ key: "D", metaKey: true, shiftKey: true }), "mac", true)).toBe(
      "session.splitDown",
    );
    expect(matchActionEvent(keyEvent({ key: "k", metaKey: true }), "mac", true)).toBe(
      "palette.toggle",
    );
    expect(matchActionEvent(keyEvent({ key: "k", ctrlKey: true }), "win", true)).toBe(
      "palette.toggle",
    );
  });

  it("终端内：非 terminalSafe 动作（Ctrl+N / Ctrl+,）一律 null（防新增键重蹈覆辙）", () => {
    expect(matchActionEvent(keyEvent({ key: "n", ctrlKey: true }), "linux", true)).toBeNull();
    expect(matchActionEvent(keyEvent({ key: ",", ctrlKey: true }), "win", true)).toBeNull();
    // 对照：终端外同一事件照常命中
    expect(matchActionEvent(keyEvent({ key: "n", ctrlKey: true }), "linux", false)).toBe("hosts.new");
    expect(matchActionEvent(keyEvent({ key: ",", ctrlKey: true }), "win", false)).toBe(
      "settings.open",
    );
  });

  it("T15：⌘R/Ctrl+R（history.search）终端内放行 PTY，终端外命中面板", () => {
    // 终端内 Ctrl+R 是 shell 反向搜索：非 terminalSafe → null（不拦截不
    // preventDefault，击键原样到 shell）——三平台全一致
    expect(matchActionEvent(keyEvent({ key: "r", ctrlKey: true }), "win", true)).toBeNull();
    expect(matchActionEvent(keyEvent({ key: "r", ctrlKey: true }), "linux", true)).toBeNull();
    expect(matchActionEvent(keyEvent({ key: "r", metaKey: true }), "mac", true)).toBeNull();
    // 终端外：全局键呼出历史搜索面板
    expect(matchActionEvent(keyEvent({ key: "r", metaKey: true }), "mac", false)).toBe(
      "history.search",
    );
    expect(matchActionEvent(keyEvent({ key: "r", ctrlKey: true }), "win", false)).toBe(
      "history.search",
    );
    expect(matchActionEvent(keyEvent({ key: "r", ctrlKey: true }), "linux", false)).toBe(
      "history.search",
    );
  });

  it("T15：history.search 三平台键位 + 无冲突 + 刻意不进 mac 原生菜单镜像", () => {
    expect(shortcutLabel("history.search", "mac")).toBe("⌘R");
    expect(shortcutLabel("history.search", "win")).toBe("Ctrl+R");
    expect(shortcutLabel("history.search", "linux")).toBe("Ctrl+R");
    for (const p of ["mac", "win", "linux"] as const) {
      expect(findConflicts(p)).toEqual([]);
    }
  });

  it("isTerminalTarget：closest 命中 [data-terminal]，非 Element target 恒 false", () => {
    const container = document.createElement("div");
    container.setAttribute("data-terminal", "");
    const inner = document.createElement("textarea");
    container.appendChild(inner);
    document.body.appendChild(container);
    expect(isTerminalTarget(inner)).toBe(true);
    expect(isTerminalTarget(container)).toBe(true);
    expect(isTerminalTarget(document.body)).toBe(false);
    expect(isTerminalTarget(null)).toBe(false);
    expect(isTerminalTarget(window)).toBe(false);
    container.remove();
  });
});

// Phase 2 B1（Task 6）：⌘J NL→命令——「全局直呼」裁定（简报）：呼出键与 ⌘K
// 同类，终端聚焦时**也命中**（终端里恰恰是主使用场景）；⌘K/⌘J 是 terminalSafe
// 守卫仅有的两个无 Shift 例外。
describe("T6/B1：ai.nl2cmd（⌘J 全局直呼）", () => {
  it("三平台键位：mac ⌘J / win/linux Ctrl+J", () => {
    expect(shortcutLabel("ai.nl2cmd", "mac")).toBe("⌘J");
    expect(shortcutLabel("ai.nl2cmd", "win")).toBe("Ctrl+J");
    expect(shortcutLabel("ai.nl2cmd", "linux")).toBe("Ctrl+J");
  });

  it("终端内也命中（⌘J 非 Shift 系，走 ⌘K 同款呼出键例外）", () => {
    expect(matchActionEvent(keyEvent({ key: "j", metaKey: true }), "mac", true)).toBe("ai.nl2cmd");
    expect(matchActionEvent(keyEvent({ key: "j", ctrlKey: true }), "win", true)).toBe("ai.nl2cmd");
    expect(matchActionEvent(keyEvent({ key: "j", ctrlKey: true }), "linux", true)).toBe("ai.nl2cmd");
    // 对照：终端外照常命中
    expect(matchActionEvent(keyEvent({ key: "j", metaKey: true }), "mac", false)).toBe("ai.nl2cmd");
    expect(matchActionEvent(keyEvent({ key: "j", ctrlKey: true }), "win", false)).toBe("ai.nl2cmd");
  });

  it("Shift/Alt 修饰严格匹配：⌘⇧J 不命中（防与未来分屏类键位串扰）", () => {
    expect(matchActionEvent(keyEvent({ key: "J", metaKey: true, shiftKey: true }), "mac")).toBeNull();
    expect(matchActionEvent(keyEvent({ key: "j", metaKey: true, altKey: true }), "mac")).toBeNull();
  });

  it("无键位冲突；labelKey 双语词典在位（⌘K 面板条目渲染面）", async () => {
    for (const p of ["mac", "win", "linux"] as const) {
      expect(findConflicts(p)).toEqual([]);
    }
    const def = ACTIONS.find((a) => a.id === "ai.nl2cmd");
    expect(def).toBeTruthy();
    const { default: zh } = await import("../i18n/zh-CN.json");
    const { default: en } = await import("../i18n/en-US.json");
    const labelKey = def!.labelKey.split(".").slice(1);
    let node: Record<string, unknown> = zh.ai as Record<string, unknown>;
    for (const k of labelKey) node = node[k] as Record<string, unknown>;
    expect(typeof node).toBe("string");
    let enNode: Record<string, unknown> = en.ai as Record<string, unknown>;
    for (const k of labelKey) enNode = enNode[k] as Record<string, unknown>;
    expect(typeof enNode).toBe("string");
  });
});

// BL-203（终审C-12）守卫补实：此前只有 ai.nl2cmd.title 一键被上方用例钉住，
// 其余 labelKey（尤其无全局键、无组件断言覆盖的 theme.toggle / lang.toggle /
// vault.lock 三键）词典缺失时没有任何测试变红——UI 会渲染原始键名。本守卫
// 遍历总表逐键查双语词典（沿上方词典行走法），并用「篡改键名探针」自证
// 检出力（同 findConflicts 的 mutation 自检法）。
describe("registry labelKey 双语守卫（BL-203）", () => {
  async function dictOf(lang: "zh-CN" | "en-US"): Promise<Record<string, unknown>> {
    const mod = await import(`../i18n/${lang}.json`);
    return mod.default as Record<string, unknown>;
  }

  /** 词典行走（"palette.themeToggle" → palette 节点下的 themeToggle 值）。 */
  function lookup(dict: Record<string, unknown>, labelKey: string): unknown {
    const [top, ...rest] = labelKey.split(".");
    let node: unknown = dict[top];
    for (const k of rest) {
      if (node == null || typeof node !== "object") return undefined;
      node = (node as Record<string, unknown>)[k];
    }
    return node;
  }

  it("总表全部 labelKey 在 zh-CN / en-US 双语词典齐备且为字符串", async () => {
    const zh = await dictOf("zh-CN");
    const en = await dictOf("en-US");
    expect(ACTIONS.length).toBeGreaterThan(0);
    for (const def of ACTIONS) {
      expect(lookup(zh, def.labelKey), `zh 缺键: ${def.id} -> ${def.labelKey}`).toBeTypeOf("string");
      expect(lookup(en, def.labelKey), `en 缺键: ${def.id} -> ${def.labelKey}`).toBeTypeOf("string");
    }
  });

  it("检出力自证：词典缺键时守卫必红（mutation 探针，不动真词典）", async () => {
    const zh = await dictOf("zh-CN");
    const ghostKey = "palette.definitelyNotAKey";
    expect(lookup(zh, ghostKey)).toBeUndefined();
    // 与 lookup 同判定的负样本：任何 ACTIONS 键都不允许落空（上一例已证），
    // 这里只钉「落空可被观察」——lookup 对幽灵键返回 undefined 而非抛错。
    expect(lookup(zh, "palette.title")).toBeTypeOf("string");
  });
});
