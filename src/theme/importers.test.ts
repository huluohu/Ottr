// 配色导入器解析 golden（Phase 2 Task 9 Step 1，TDD）：
// 夹具 = 真实样例（fixtures/itermcolors/snazzy.itermcolors 官方 Snazzy 全 22 通道
// plist；fixtures/winterm/settings-fragment.json 官方 Campbell/One Half Dark）。
// golden 逐字段锁定，防解析器回归静默改变导入语义。
import { describe, expect, it } from "vitest";
import itermRaw from "../../fixtures/itermcolors/snazzy.itermcolors?raw";
import wintermRaw from "../../fixtures/winterm/settings-fragment.json?raw";
import { parseItermColors } from "./importers/iterm";
import { parseWintermScheme, parseWintermSchemes } from "./importers/winterm";

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
