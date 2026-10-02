// 插件系统类型面（Phase 4 Task 6，C3 foundation）。
//
// 安全裁定（ADR docs/adr/0002-plugin-external-execution.md）：Phase 4 的插件 =
// **声明式 manifest + 内置注册表**，不加载、不执行任何外部代码——外部插件执行面
// scope-out。本模块只描述数据契约：manifest（name/version/permissions）与两类
// 贡献面（侧栏卡片/快捷命令）。贡献面是纯数据（id/labelKey/command 字符串），
// 渲染组件由内置模块注册（builtin/index.ts），外部输入永远到不了组件层。
//
// 权限模型（docs/plugins.md §3）：closed-set 声明式权限——loader 按声明白名单
// 装载贡献面，越权贡献直接丢弃并记 violation（可审计），而非报错崩溃。

/** 权限词表（封闭集：新增权限 = 改这里 + docs/plugins.md + loader 门控面）。 */
export const PLUGIN_PERMISSIONS = [
  /** 读取监控采样快照（monitorStore.windows 只读面）。 */
  "monitor.read",
  /** 向终端侧栏贡献卡片。 */
  "sidebar.card",
  /** 贡献快捷命令（快捷命令包卡片；palette 注入属后续挂载点，foundation 不含）。 */
  "palette.commands",
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** 插件 manifest：全部声明式，无可执行字段。 */
export interface PluginManifest {
  /** 全局唯一 id：kebab-case（`/^[a-z][a-z0-9-]{1,63}$/`）。 */
  name: string;
  /** semver 三段（MAJOR.MINOR.PATCH）。 */
  version: string;
  /** 标题 i18n 词典键（zh-CN/en-US 双语齐全，i18n.test 守卫）。 */
  titleKey: string;
  /** 声明的权限（可空数组 = 纯元数据插件）。 */
  permissions: PluginPermission[];
}

/** 侧栏卡片贡献：纯数据占位，渲染组件由内置注册表按 id 提供。 */
export interface PluginSidebarCard {
  /** 注册表内唯一（约定 `${name}.card`）。 */
  id: string;
}

/** 快捷命令贡献：纯数据（命令串由用户显式复制/后续显式注入，插件不自动执行）。 */
export interface PluginQuickCommand {
  /** 注册表内唯一（约定 `${name}.${slug}`）。 */
  id: string;
  /** 展示名 i18n 词典键。 */
  labelKey: string;
  /** 命令原文（明文展示——用户看得见才点得放心）。 */
  command: string;
}

/** 插件总形：manifest + 可选贡献面。 */
export interface OttrPlugin {
  manifest: PluginManifest;
  sidebarCards?: PluginSidebarCard[];
  quickCommands?: PluginQuickCommand[];
}

// --- 校验结果 -----------------------------------------------------------------

export type ManifestErrorCode =
  | "not-an-object"
  | "invalid-name"
  | "invalid-version"
  | "invalid-title-key"
  | "invalid-permissions"
  | "unknown-permission"
  | "duplicate-permission";

export interface ManifestError {
  code: ManifestErrorCode;
  detail: string;
}

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: ManifestError };

// --- 装载结果 -----------------------------------------------------------------

export interface LoadedPlugin {
  manifest: PluginManifest;
}

export interface LoadedCard {
  /** 来源插件名（卡片渲染/审计用）。 */
  plugin: string;
  card: PluginSidebarCard;
}

export interface LoadedQuickCommand {
  plugin: string;
  command: PluginQuickCommand;
}

/** 注册表：装载产物 + violation 审计账（丢弃不静默）。 */
export interface PluginRegistry {
  plugins: LoadedPlugin[];
  cards: LoadedCard[];
  quickCommands: LoadedQuickCommand[];
  violations: string[];
}
