// winterm.ts（Phase 2 Task 9，B2 主题生态）：Windows Terminal 配色 scheme（JSON）解析。
//
// 格式：settings.json 的 schemes 片段——单 scheme 对象 / scheme 数组 /
// `{"schemes": [...]}` 三种形态都收（用户导出的可能是任意一层裁剪）。
// 通道名直接用 ITheme 语义（唯一差异：WT 用 `purple`/`brightPurple` 表
// magenta，映射时并轨；`cursorColor`→cursor、`selectionBackground` 同名）。
// 校验纪律：name+background+foreground 三缺一即该 scheme 无效；颜色值必须
// 是 #rgb/#rrggbb/#rrggbbaa 十六进制（css 颜色名/rgb() 不收——导入面宁可
// 少导不错导，坏值计入错误信息）。全部 scheme 无效 → throw。
import type { ITheme } from "@xterm/xterm";
import { isDarkBackground } from "../gallery";
import type { ParsedColorScheme } from "./iterm";

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** 通道字段映射（WT 键 → ITheme 键；purple 系并轨 magenta）。 */
const CHANNELS: [wtKey: string, themeKey: keyof ITheme][] = [
  ["foreground", "foreground"],
  ["background", "background"],
  ["cursorColor", "cursor"],
  ["cursorAccent", "cursorAccent"], // 非 WT 官方键，导出件偶见——有则收
  ["selectionBackground", "selectionBackground"],
  ["black", "black"],
  ["red", "red"],
  ["green", "green"],
  ["yellow", "yellow"],
  ["blue", "blue"],
  ["purple", "magenta"],
  ["cyan", "cyan"],
  ["white", "white"],
  ["brightBlack", "brightBlack"],
  ["brightRed", "brightRed"],
  ["brightGreen", "brightGreen"],
  ["brightYellow", "brightYellow"],
  ["brightBlue", "brightBlue"],
  ["brightPurple", "brightMagenta"],
  ["brightCyan", "brightCyan"],
  ["brightWhite", "brightWhite"],
];

/** 单 scheme → 主题定义。name/bg/fg 缺、颜色非法 → throw（调用方按 scheme 粒度接）。 */
export function parseWintermScheme(raw: Record<string, unknown>): ParsedColorScheme {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new Error("scheme without a name");
  const theme: ITheme = {};
  for (const [wtKey, themeKey] of CHANNELS) {
    const v = raw[wtKey];
    if (typeof v !== "string" || !HEX_RE.test(v.trim())) continue;
    (theme[themeKey] as unknown) = v.trim().toLowerCase();
  }
  if (typeof theme.background !== "string" || typeof theme.foreground !== "string") {
    throw new Error(`scheme "${name}" lacks background/foreground`);
  }
  return { name, dark: isDarkBackground(theme.background), theme };
}

/** 从 JSON 文本解出全部合法 scheme（对象/数组/{schemes:[…]} 三形态）。
 * 单个坏 scheme 不拖垮整批：跳过并汇入 errors（报告面展示）。 */
export function parseWintermSchemes(text: string): {
  schemes: ParsedColorScheme[];
  errors: string[];
} {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  const list: unknown[] = Array.isArray(doc)
    ? doc
    : doc && typeof doc === "object" && Array.isArray((doc as { schemes?: unknown }).schemes)
      ? ((doc as { schemes: unknown[] }).schemes)
      : [doc];
  const schemes: ParsedColorScheme[] = [];
  const errors: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      errors.push("ignored a non-object entry");
      continue;
    }
    try {
      schemes.push(parseWintermScheme(item as Record<string, unknown>));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (schemes.length === 0) {
    throw new Error(errors[0] ?? "no usable schemes found");
  }
  return { schemes, errors };
}
