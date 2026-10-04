// 配色导入器解析 golden（Phase 2 Task 9 Step 1，TDD）：
// 夹具 = 真实样例（fixtures/itermcolors/snazzy.itermcolors 官方 Snazzy 全 22 通道
// plist；fixtures/winterm/settings-fragment.json 官方 Campbell/One Half Dark）。
// golden 逐字段锁定，防解析器回归静默改变导入语义。
// bplist 夹具（BL-512，.b64 文本存二进制——?raw 直读二进制会经 UTF-8 解码失真）：
//   * minimal.bplist.b64——dict/string/real/array/int/bool/date/data 全型样本；
//   * snazzy-binary.bplist.b64——snazzy.itermcolors 经 macOS plistlib dump 成
//     FMT_BINARY 的等价二进制（Apple 实现产出，非自写编码器回文）。
//   重建命令（plistlib.load XML → dump FMT_BINARY → base64，minimal 同理手构造
//   dict 后 dump）：
//     python3 -c "import plistlib; d=plistlib.load(open('fixtures/itermcolors/snazzy.itermcolors','rb')); plistlib.dump(d, open('/tmp/x.bplist','wb'), fmt=plistlib.FMT_BINARY)"
//     base64 -i /tmp/x.bplist | tr -d '\n' > fixtures/itermcolors/snazzy-binary.bplist.b64
import { describe, expect, it } from "vitest";
import itermRaw from "../../fixtures/itermcolors/snazzy.itermcolors?raw";
import wintermRaw from "../../fixtures/winterm/settings-fragment.json?raw";
import minimalB64 from "../../fixtures/itermcolors/minimal.bplist.b64?raw";
import snazzyBinaryB64 from "../../fixtures/itermcolors/snazzy-binary.bplist.b64?raw";
import { isBplistMagic, parseBplist } from "./importers/bplist";
import { parseItermColors, parseItermColorsBinary } from "./importers/iterm";
import { parseThemeFileBytes } from "./importers";
import { parseWintermScheme, parseWintermSchemes } from "./importers/winterm";

/** base64 文本 → 字节（bplist 夹具解码面）。 */
function b64bytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 官方 Snazzy 16 色（draculalike 亮白 fg；bright 9-14 与 normal 同值是官方原样）
const SNAZZY_ANSI = {
  black: "#282a36",
  red: "#ff5c57",
  green: "#5af78e",
  yellow: "#f3f99d",
  blue: "#57c7ff",
  magenta: "#ff6ac1",
  cyan: "#9aedfe",
  white: "#f1f1f0",
  brightBlack: "#686689",
  brightRed: "#ff5c57",
  brightGreen: "#5af78e",
  brightYellow: "#f3f99d",
  brightBlue: "#57c7ff",
  brightMagenta: "#ff6ac1",
  brightCyan: "#9aedfe",
  brightWhite: "#eff0eb",
};

describe("parseItermColors（iTerm2 .itermcolors plist）", () => {
  it("golden：Snazzy 夹具全通道解析（fg/bg/cursor/selection/16 色）", () => {
    const parsed = parseItermColors(itermRaw);
    expect(parsed.name).toBe("iTerm2 Import");
    expect(parsed.dark).toBe(true); // 背景亮度 < 0.5
    expect(parsed.theme.background).toBe("#1e1f29");
    expect(parsed.theme.foreground).toBe("#eff0eb");
    expect(parsed.theme.cursor).toBe("#97979b");
    expect(parsed.theme.cursorAccent).toBe("#1e1f29");
    expect(parsed.theme.selectionBackground).toBe("#97979b");
    expect(parsed.theme).toMatchObject(SNAZZY_ANSI);
  });

  it("大小写不敏感（ANSI 0 Color 变体）+ Bold Color 补位 brightWhite", () => {
    const trimmed = `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>ANSI 0 Color</key><dict><key>Red Component</key><real>0.1</real>
      <key>Green Component</key><real>0.2</real><key>Blue Component</key><real>0.3</real></dict>
      <key>Bold Color</key><dict><key>Red Component</key><real>1</real>
      <key>Green Component</key><real>1</real><key>Blue Component</key><real>1</real></dict>
      <key>Foreground Color</key><dict><key>Red Component</key><real>1</real>
      <key>Green Component</key><real>0.9</real><key>Blue Component</key><real>0.8</real></dict>
      <key>Background Color</key><dict><key>Red Component</key><real>0.05</real>
      <key>Green Component</key><real>0.05</real><key>Blue Component</key><real>0.05</real></dict>
    </dict></plist>`;
    const parsed = parseItermColors(trimmed);
    expect(parsed.theme.black).toBe("#1a334d"); // round(0.1*255)=26=0x1a …
    expect(parsed.theme.brightWhite).toBe("#ffffff"); // Ansi 15 缺席 → Bold Color 补位
  });

  it("坏结构：非 XML / 无 dict / 缺 fg+bg → throw", () => {
    expect(() => parseItermColors("this is not xml <")).toThrow();
    expect(() => parseItermColors("<plist version='1.0'></plist>")).toThrow(/no top-level dict/);
    expect(() =>
      parseItermColors("<plist><dict><key>Unrelated</key><string>x</string></dict></plist>"),
    ).toThrow(/missing Foreground\/Background/);
  });
});

describe("parseWintermSchemes（Windows Terminal scheme JSON）", () => {
  it("golden：settings.json 片段夹具（schemes 数组）两套全 16 色", () => {
    const { schemes, errors } = parseWintermSchemes(wintermRaw);
    expect(errors).toEqual([]);
    expect(schemes.map((s) => s.name)).toEqual(["Campbell", "One Half Dark"]);
    const campbell = schemes[0];
    expect(campbell.dark).toBe(true);
    // purple → magenta 并轨；cursorColor → cursor
    expect(campbell.theme.background).toBe("#0c0c0c");
    expect(campbell.theme.foreground).toBe("#cccccc");
    expect(campbell.theme.cursor).toBe("#ffffff");
    expect(campbell.theme.selectionBackground).toBe("#ffffff");
    expect(campbell.theme.magenta).toBe("#881798");
    expect(campbell.theme.brightMagenta).toBe("#b4009e");
    expect(campbell.theme.black).toBe("#0c0c0c");
    expect(campbell.theme.red).toBe("#c50f1f");
    expect(campbell.theme.green).toBe("#13a10e");
    expect(campbell.theme.yellow).toBe("#c19c00");
    expect(campbell.theme.blue).toBe("#0037da");
    expect(campbell.theme.cyan).toBe("#3a96dd");
    expect(campbell.theme.white).toBe("#cccccc");
    expect(campbell.theme.brightBlack).toBe("#767676");
    expect(campbell.theme.brightRed).toBe("#e74856");
    expect(campbell.theme.brightGreen).toBe("#16c60c");
    expect(campbell.theme.brightYellow).toBe("#f9f1a5");
    expect(campbell.theme.brightBlue).toBe("#3b78ff");
    expect(campbell.theme.brightCyan).toBe("#61d6d6");
    expect(campbell.theme.brightWhite).toBe("#f2f2f2");
  });

  it("三形态收口：单对象 / 数组 / schemes 包装等价", () => {
    const scheme = `{"name":"T","background":"#000000","foreground":"#eeeeee","red":"#ff0000"}`;
    expect(parseWintermSchemes(scheme).schemes).toHaveLength(1);
    expect(parseWintermSchemes(`[${scheme}]`).schemes).toHaveLength(1);
    expect(parseWintermSchemes(`{"schemes":[${scheme}]}`).schemes).toHaveLength(1);
  });

  it("坏 scheme 跳过并计入 errors；全坏 / 非 JSON → throw", () => {
    const mixed = `{"schemes":[
      {"name":"Good","background":"#111111","foreground":"#eeeeee"},
      {"background":"#222222","foreground":"#eeeeee"},
      {"name":"BadColor","background":"#333333","foreground":"rgb(1,2,3)"}
    ]}`;
    const { schemes, errors } = parseWintermSchemes(mixed);
    expect(schemes.map((s) => s.name)).toEqual(["Good"]);
    expect(errors).toHaveLength(2);
    expect(() => parseWintermSchemes("{not json")).toThrow(/not valid JSON/);
    expect(() => parseWintermSchemes('{"schemes":[{"name":"x"}]}')).toThrow(/lacks background/);
  });

  it("parseWintermScheme：亮色 scheme 判 dark=false", () => {
    const light = parseWintermScheme({
      name: "Light",
      background: "#ffffff",
      foreground: "#111111",
    });
    expect(light.dark).toBe(false);
  });
});

describe("parseBplist（iTerm2 二进制 plist，BL-512）", () => {
  it("minimal 夹具：dict/string/real/int/bool/array/嵌套 dict/date/data 全型解析", () => {
    const bytes = b64bytes(minimalB64);
    expect(isBplistMagic(bytes)).toBe(true);
    const obj = parseBplist(bytes) as Record<string, unknown>;
    expect(obj["name"]).toBe("ottr-minimal");
    expect(obj["ratio"]).toBeCloseTo(1.5);
    expect(obj["count"]).toBe(3);
    expect(obj["enabled"]).toBe(true);
    expect(obj["disabled"]).toBe(false);
    expect(obj["list"]).toEqual(["alpha", "beta"]);
    expect(obj["nested"]).toEqual({ inner: "value" });
    // date：Apple 纪元（2001-01-01）→ JS Date；2026-01-01T12:00:00Z
    expect(obj["created"]).toEqual(new Date(Date.UTC(2026, 0, 1, 12, 0, 0)));
    // data：字节面（非 UTF-8 文本）
    expect(Array.from(obj["blob"] as Uint8Array)).toEqual([0x00, 0x01, 0x02, 0xfe]);
  });

  it("snazzy 二进制等价样本：解析产物与 XML 路径逐字段一致（KAT）", () => {
    const fromBinary = parseItermColorsBinary(b64bytes(snazzyBinaryB64));
    const fromXml = parseItermColors(itermRaw);
    expect(fromBinary).toEqual(fromXml);
    // 关键通道复述（防两路同时坏成同一错的空对齐）
    expect(fromBinary.theme.background).toBe("#1e1f29");
    expect(fromBinary.theme.black).toBe("#282a36");
    expect(fromBinary.theme.brightWhite).toBe("#eff0eb");
  });

  it("非 dict 顶层 / 截断 / 坏魔数 → throw（显式错误面）", () => {
    // 顶层标量（手工构一个只含 ASCII 串的 bplist：走 XML 转制不划算，直接坏样本）
    expect(() => parseBplist(new TextEncoder().encode("not a bplist at all"))).toThrow(/not a binary plist/);
    const bytes = b64bytes(snazzyBinaryB64);
    expect(() => parseBplist(bytes.slice(0, 40))).toThrow(); // 截断（魔数在但表不完整）
    const noMagic = bytes.slice(); noMagic[0] = 0x58; // 改坏首字节
    expect(isBplistMagic(noMagic)).toBe(false);
  });
});

describe("parseThemeFileBytes（导入入口字节级分流，BL-512）", () => {
  it("bplist 魔数分流到二进制解析器（扩展名无关）", () => {
    const bytes = b64bytes(snazzyBinaryB64);
    const defs = parseThemeFileBytes("mystery-file", bytes);
    expect(defs).toHaveLength(1);
    expect(defs[0].theme).toEqual(parseItermColors(itermRaw).theme);
    expect(defs[0].theme.background).toBe("#1e1f29");
  });

  it("既有文本面不回归：.itermcolors XML / .json / 无扩展名回退链", () => {
    // .itermcolors → iTerm2 XML 路径
    expect(
      parseThemeFileBytes("snazzy.itermcolors", new TextEncoder().encode(itermRaw))[0].theme.background,
    ).toBe("#1e1f29");
    // .json → winterm 路径
    expect(
      parseThemeFileBytes("schemes.json", new TextEncoder().encode(wintermRaw)).map((d) => d.name),
    ).toEqual(["Campbell", "One Half Dark"]);
    // 无扩展名：先 JSON 后 plist 回落（既有 SecuritySettings 惯例原样上收）
    expect(
      parseThemeFileBytes("dropped-here", new TextEncoder().encode(itermRaw))[0].theme.background,
    ).toBe("#1e1f29");
  });
});
