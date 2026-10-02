// 插件 loader（Phase 4 Task 6，C3 foundation）：内置注册表装载器。
//
// 职责（全部同步、纯数据、零动态加载）：
//   1. validateManifest：manifest 契约校验（types.ts 的声明式面）；
//   2. loadPlugins：装载数组入注册表——**权限门控**（未声明的贡献面丢弃+记
//      violation）、唯一性收口（插件名/卡片 id/命令 id 冲突丢弃后到者）、
//      畸形贡献面逐条丢弃（不殃及同插件其余贡献）；
//   3. BUILTIN_PLUGINS / loadBuiltinRegistry：内置示例的注册出口。
//
// 安全裁定（ADR docs/adr/0002-plugin-external-execution.md）：**没有** import()、
// eval、remote manifest 拉取——本模块的输入只能是编译期打包进应用的内置模块。
// 外部插件执行面 = Phase 4 out。
import type {
  LoadedCard,
  LoadedQuickCommand,
  ManifestErrorCode,
  ManifestResult,
  OttrPlugin,
  PluginManifest,
  PluginPermission,
  PluginQuickCommand,
  PluginRegistry,
  PluginSidebarCard,
} from "./types";
import { PLUGIN_PERMISSIONS } from "./types";

import { NET_SUMMARY_PLUGIN } from "./builtin/netSummary";
import { QUICK_COMMANDS_PLUGIN } from "./builtin/quickCommands";

/** kebab-case 插件名（2–64 字符，字母开头）。 */
const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;
/** semver 三段（不收 range/前缀——manifest 是身份声明不是依赖声明）。 */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function err(code: ManifestErrorCode, detail: string): ManifestResult {
  return { ok: false, error: { code, detail } };
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** manifest 契约校验：逐字段窄化，首个错误即返回（诊断面向作者）。 */
export function validateManifest(input: unknown): ManifestResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return err("not-an-object", `manifest must be an object, got ${input === null ? "null" : typeof input}`);
  }
  const m = input as Record<string, unknown>;

  if (!nonEmptyString(m.name) || !NAME_RE.test(m.name)) {
    return err("invalid-name", `name must match ${NAME_RE.source}, got ${JSON.stringify(m.name)}`);
  }
  if (!nonEmptyString(m.version) || !VERSION_RE.test(m.version)) {
    return err("invalid-version", `version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(m.version)}`);
  }
  if (!nonEmptyString(m.titleKey)) {
    return err("invalid-title-key", `titleKey must be a non-empty i18n key, got ${JSON.stringify(m.titleKey)}`);
  }

  if (!Array.isArray(m.permissions)) {
    return err("invalid-permissions", "permissions must be an array");
  }
  const seen = new Set<string>();
  const permissions: PluginPermission[] = [];
  for (const p of m.permissions) {
    if (!nonEmptyString(p) || !PLUGIN_PERMISSIONS.includes(p as PluginPermission)) {
      return err("unknown-permission", `unknown permission ${JSON.stringify(p)}（词表见 types.ts PLUGIN_PERMISSIONS）`);
    }
    if (seen.has(p)) {
      return err("duplicate-permission", `duplicate permission ${p}`);
    }
    seen.add(p);
    permissions.push(p as PluginPermission);
  }

  return {
    ok: true,
    manifest: {
      name: m.name,
      version: m.version,
      titleKey: m.titleKey,
      permissions,
    },
  };
}

function validCard(card: unknown): card is PluginSidebarCard {
  return (
    card !== null &&
    typeof card === "object" &&
    !Array.isArray(card) &&
    nonEmptyString((card as PluginSidebarCard).id)
  );
}

function validCommand(cmd: unknown): cmd is PluginQuickCommand {
  const c = cmd as PluginQuickCommand;
  return (
    c !== null &&
    typeof c === "object" &&
    !Array.isArray(c) &&
    nonEmptyString(c.id) &&
    nonEmptyString(c.labelKey) &&
    nonEmptyString(c.command)
  );
}

/** 装载插件数组：校验 → 门控 → 收口。永不 throw——一切拒绝记入 violations。 */
export function loadPlugins(plugins: readonly OttrPlugin[]): PluginRegistry {
  const reg: PluginRegistry = { plugins: [], cards: [], quickCommands: [], violations: [] };
  const pluginNames = new Set<string>();
  const cardIds = new Set<string>();
  const commandIds = new Set<string>();

  plugins.forEach((p, index) => {
    const r = validateManifest(p?.manifest);
    if (!r.ok) {
      reg.violations.push(`plugin[${index}]: invalid manifest (${r.error.code}: ${r.error.detail})`);
      return;
    }
    if (pluginNames.has(r.manifest.name)) {
      reg.violations.push(`plugin[${index}]: duplicate plugin name "${r.manifest.name}"（首个 wins）`);
      return;
    }
    pluginNames.add(r.manifest.name);
    reg.plugins.push({ manifest: r.manifest });
    const name = r.manifest.name;
    const granted = new Set<PluginPermission>(r.manifest.permissions);

    for (const card of p.sidebarCards ?? []) {
      if (!validCard(card)) {
        reg.violations.push(`${name}: dropped malformed sidebarCard ${JSON.stringify(card)}`);
        continue;
      }
      if (!granted.has("sidebar.card")) {
        reg.violations.push(`${name}: sidebar card "${card.id}" dropped——manifest 未声明 sidebar.card 权限`);
        continue;
      }
      if (cardIds.has(card.id)) {
        reg.violations.push(`${name}: duplicate card id "${card.id}"（首个 wins）`);
        continue;
      }
      cardIds.add(card.id);
      reg.cards.push({ plugin: name, card });
    }

    for (const cmd of p.quickCommands ?? []) {
      if (!validCommand(cmd)) {
        reg.violations.push(`${name}: dropped malformed quickCommand ${JSON.stringify(cmd)}`);
        continue;
      }
      if (!granted.has("palette.commands")) {
        reg.violations.push(`${name}: quick command "${cmd.id}" dropped——manifest 未声明 palette.commands 权限`);
        continue;
      }
      if (commandIds.has(cmd.id)) {
        reg.violations.push(`${name}: duplicate command id "${cmd.id}"（首个 wins）`);
        continue;
      }
      commandIds.add(cmd.id);
      reg.quickCommands.push({ plugin: name, command: cmd });
    }
  });

  return reg;
}

/** 内置插件总表（编译期打包，顺序 = 侧栏卡片展示顺序）。 */
export const BUILTIN_PLUGINS: readonly OttrPlugin[] = [NET_SUMMARY_PLUGIN, QUICK_COMMANDS_PLUGIN];

/** 内置注册表便捷出口（内置面恒定干净：violation 恒空，测试钉死）。 */
export function loadBuiltinRegistry(): PluginRegistry {
  return loadPlugins(BUILTIN_PLUGINS);
}

// 常用面再导出（组件面/测试只 import 本模块即可）。
export { PLUGIN_PERMISSIONS } from "./types";
export type { LoadedCard, LoadedQuickCommand, PluginManifest, PluginRegistry };
