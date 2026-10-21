// 按键捕获归一（设置→快捷键「修改」态）：KeyboardEvent → 平台中性加速串。
//
// 归一口径与匹配器（registry.matchesAccelerator）同源：
// * 修饰键：metaKey / ctrlKey 任一 → `CmdOrCtrl`（运行时两者皆可命中，且换
//   平台语义不跑偏）；altKey → `Alt`；shiftKey → `Shift`。规范化顺序固定
//   CmdOrCtrl → Shift → Alt（与既有表字面量形态一致）。
// * 键名：e.key 原样（匹配侧 toLowerCase 比对，CapsLock 不破坏）。`+` 是
//   加速串分隔符，不可表达 → reserved。
// 拒绝面（改键校验，错误可内联展示）：裸修饰键（捕获中忽略、继续听）；
// Escape / Tab / Enter / 空格（导航与关闭语义，永不改绑）；无任何修饰键且
// 非 F1-F24（裸字母在输入 anywhere 误触——M-4 纪律）；`+`（分隔符冲突）。
import type { Platform } from "./registry";

const BARE_MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);
const RESERVED_KEYS = new Set(["Escape", "Tab", "Enter", " "]);
const F_KEY_RE = /^F([1-9]|1\d|2[0-4])$/i;

export type CaptureResult =
  | { kind: "ignore" }
  | { kind: "cancel" }
  | { kind: "reserved" }
  | { kind: "noModifier" }
  | { kind: "accel"; accel: string };

export function normalizeCapture(e: KeyboardEvent, plat: Platform): CaptureResult {
  if (e.key === "Escape") return { kind: "cancel" };
  if (BARE_MODIFIER_KEYS.has(e.key)) return { kind: "ignore" };
  if (RESERVED_KEYS.has(e.key) || e.key === "+") return { kind: "reserved" };

  const parts: string[] = [];
  const mod = e.metaKey || e.ctrlKey;
  if (mod) parts.push("CmdOrCtrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const key = e.key.length === 1 ? e.key : e.key;
  if (parts.length === 0 && !F_KEY_RE.test(key)) return { kind: "noModifier" };
  // mac 的 ⌃（ctrlKey）在 win/linux 无对应语义且 CmdOrCtrl 已覆盖两修饰键
  void plat;
  return { kind: "accel", accel: [...parts, key].join("+") };
}
