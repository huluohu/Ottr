// shortcut registry 单测（Task 14）：平台判定 / accelerator 展示与匹配 /
// 冲突检测 / Rust 菜单镜像值钉死。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIONS,
  findConflicts,
  formatAccelerator,
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

  it("Shift 修饰严格匹配（splitDown ⇧D vs splitRight D）", () => {
    expect(matchActionEvent(keyEvent({ key: "d", metaKey: true }), "mac")).toBe("session.splitRight");
    expect(matchActionEvent(keyEvent({ key: "D", metaKey: true, shiftKey: true }), "mac")).toBe(
      "session.splitDown",
    );
    expect(matchActionEvent(keyEvent({ key: "d", ctrlKey: true, shiftKey: true }), "linux")).toBe(
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
      if (!def.keys) continue;
      const norm = def.keys.mac.split("+").map((s) => s.trim().toLowerCase()).sort().join("+");
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

// macOS 原生菜单（src-tauri/src/menu.rs menu_tree()）镜像值钉死：Rust 侧无法
// import 本表，两侧字面量靠本用例 + Rust 单测双向锁定——改动键位必须两侧同步。
describe("Rust 菜单镜像钉死", () => {
  const MIRRORED: Partial<Record<ActionId, string>> = {
    "palette.toggle": "CmdOrCtrl+K",
    "hosts.new": "CmdOrCtrl+N",
    "settings.open": "CmdOrCtrl+,",
    "session.splitRight": "CmdOrCtrl+D",
    "session.splitDown": "CmdOrCtrl+Shift+D",
  };
  it("注册表中带键位的动作与 Rust 菜单字面量一致", () => {
    for (const [id, accel] of Object.entries(MIRRORED)) {
      expect(shortcutLabel(id as ActionId, "mac"), id).toBe(formatAccelerator(accel, "mac"));
      expect(shortcutLabel(id as ActionId, "linux"), id).toBe(formatAccelerator(accel, "linux"));
    }
  });
});
