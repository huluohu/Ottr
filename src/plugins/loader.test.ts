// 插件 loader 单测（Phase 4 Task 6，C3 foundation，TDD）：
// manifest 校验（name/version/permissions 声明式契约）+ 内置注册表装载
// （权限门控：贡献面越权即丢弃+记 violation）+ 内置示例自洽性。
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PLUGINS,
  PLUGIN_PERMISSIONS,
  loadBuiltinRegistry,
  loadPlugins,
  validateManifest,
} from "./loader";
import type { OttrPlugin } from "./types";

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test-plugin",
    version: "0.1.0",
    titleKey: "plugins.title",
    permissions: ["sidebar.card"],
    ...over,
  };
}

function plugin(over: Partial<OttrPlugin> = {}): OttrPlugin {
  return {
    manifest: manifest() as unknown as OttrPlugin["manifest"],
    sidebarCards: [{ id: "test-plugin.card" }],
    ...over,
  };
}

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    const r = validateManifest(manifest());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.name).toBe("test-plugin");
      expect(r.manifest.permissions).toEqual(["sidebar.card"]);
    }
  });

  it("rejects non-object input", () => {
    for (const bad of [null, undefined, "x", 42, []]) {
      const r = validateManifest(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("not-an-object");
    }
  });

  it("rejects bad names（空/大写/数字开头/含下划线）", () => {
    for (const name of ["", "Xyz", "9lives", "has_underscore", "has space"]) {
      const r = validateManifest(manifest({ name }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid-name");
    }
  });

  it("rejects bad versions（缺 patch/前缀 v/四位段）", () => {
    for (const version of ["", "1.2", "v1.2.3", "1.2.3.4", "1.2.x"]) {
      const r = validateManifest(manifest({ version }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid-version");
    }
  });

  it("rejects missing/empty titleKey", () => {
    for (const titleKey of [undefined, "", 42]) {
      const r = validateManifest(manifest({ titleKey }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid-title-key");
    }
  });

  it("rejects permissions that are not an array of known strings", () => {
    for (const permissions of [undefined, {}, ["nope"], ["monitor.read", 1]]) {
      const r = validateManifest(manifest({ permissions }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const expected = permissions === undefined || !Array.isArray(permissions)
          ? "invalid-permissions"
          : "unknown-permission";
        expect(r.error.code).toBe(expected);
      }
    }
  });

  it("rejects duplicate permissions and accepts empty permission list", () => {
    const dup = validateManifest(manifest({ permissions: ["monitor.read", "monitor.read"] }));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("duplicate-permission");

    const empty = validateManifest(manifest({ permissions: [] }));
    expect(empty.ok).toBe(true);
  });

  it("permission vocabulary is the declared closed set", () => {
    expect([...PLUGIN_PERMISSIONS]).toEqual(["monitor.read", "sidebar.card", "palette.commands"]);
  });
});

describe("loadPlugins（内置注册表装载）", () => {
  it("aggregates contributions only for declared permissions", () => {
    const reg = loadPlugins([
      plugin({
        manifest: manifest({ permissions: ["sidebar.card", "palette.commands"] }) as never,
        sidebarCards: [{ id: "a.card" }],
        quickCommands: [{ id: "a.cmd", labelKey: "x", command: "uptime" }],
      }),
    ]);
    expect(reg.violations).toEqual([]);
    expect(reg.cards.map((c) => c.card.id)).toEqual(["a.card"]);
    expect(reg.quickCommands.map((c) => c.command.command)).toEqual(["uptime"]);
  });

  it("drops contributions whose permission is not declared（越权门控）", () => {
    const reg = loadPlugins([
      plugin({
        manifest: manifest({ permissions: ["sidebar.card"] }) as never,
        sidebarCards: [{ id: "a.card" }],
        quickCommands: [{ id: "a.cmd", labelKey: "x", command: "uptime" }],
      }),
    ]);
    expect(reg.cards.map((c) => c.card.id)).toEqual(["a.card"]);
    expect(reg.quickCommands).toEqual([]);
    expect(reg.violations).toHaveLength(1);
    expect(reg.violations[0]).toContain("palette.commands");
    expect(reg.violations[0]).toContain("test-plugin");
  });

  it("rejects invalid manifests and duplicate plugin names（首个 wins）", () => {
    const bad = validateManifest(manifest({ version: "1.2" }));
    expect(bad.ok).toBe(false);

    const reg = loadPlugins([
      plugin({ manifest: manifest({ version: "1.2" }) as never }),
      plugin({ sidebarCards: [{ id: "first.card" }] }),
      plugin({ sidebarCards: [{ id: "second.card" }] }), // 同名 → 拒绝
    ]);
    expect(reg.plugins).toHaveLength(1);
    expect(reg.cards.map((c) => c.card.id)).toEqual(["first.card"]);
    expect(reg.violations).toHaveLength(2);
    expect(reg.violations[0]).toContain("invalid manifest");
    expect(reg.violations[1]).toContain("duplicate plugin name");
  });

  it("distinct plugin names load in input order（卡片展示顺序 = 装载顺序）", () => {
    const reg = loadPlugins([
      plugin({ manifest: manifest({ name: "alpha" }) as never, sidebarCards: [{ id: "a.card" }] }),
      plugin({ manifest: manifest({ name: "beta" }) as never, sidebarCards: [{ id: "b.card" }] }),
    ]);
    expect(reg.plugins.map((p) => p.manifest.name)).toEqual(["alpha", "beta"]);
    expect(reg.cards.map((c) => c.card.id)).toEqual(["a.card", "b.card"]);
  });

  it("drops malformed contributions and duplicate card/command ids", () => {
    const reg = loadPlugins([
      plugin({
        manifest: manifest({ permissions: ["sidebar.card", "palette.commands"] }) as never,
        sidebarCards: [{ id: "" }, { id: "dup.card" }, { id: "dup.card" }, "junk" as never],
        quickCommands: [
          { id: "ok.cmd", labelKey: "x", command: "uptime" },
          { id: "", labelKey: "x", command: "uptime" },
          { id: "no.cmd", labelKey: "", command: "uptime" },
          { id: "no2.cmd", labelKey: "x", command: "" },
        ],
      }),
    ]);
    expect(reg.cards.map((c) => c.card.id)).toEqual(["dup.card"]);
    expect(reg.quickCommands.map((c) => c.command.id)).toEqual(["ok.cmd"]);
    expect(reg.violations.length).toBeGreaterThanOrEqual(5);
  });
});

describe("内置插件自洽性（随 loader 一起钉死）", () => {
  it("BUILTIN_PLUGINS = 2（网络摘要卡片/快捷命令包）且 manifest 全部可验", () => {
    expect(BUILTIN_PLUGINS).toHaveLength(2);
    for (const p of BUILTIN_PLUGINS) {
      const r = validateManifest(p.manifest);
      expect(r.ok, `builtin ${p.manifest?.name ?? "?"} manifest 应合法`).toBe(true);
    }
    expect(BUILTIN_PLUGINS.map((p) => p.manifest.name).sort()).toEqual([
      "net-summary",
      "quick-commands",
    ]);
  });

  it("内置贡献面全部有权限背书，装载后 violation 为空", () => {
    const reg = loadBuiltinRegistry();
    expect(reg.plugins).toHaveLength(2);
    expect(reg.violations).toEqual([]);
    expect(reg.cards.map((c) => c.card.id).sort()).toEqual(["net-summary.card", "quick-commands.card"]);
    expect(reg.quickCommands.length).toBe(4);
    for (const c of reg.quickCommands) {
      expect(c.command.command.length).toBeGreaterThan(0);
    }
  });
});
