// 画廊审计测试（Phase 2 Task 9 Step 2）：内置 8 主题逐套核对——ANSI 16 色
// 全通道在位 + 十六进制合法性 + 明暗标注与背景实际亮度一致 + 品牌双主题与
// terminal-themes 单源同引用（auto 语义不漂移）。
import { describe, expect, it } from "vitest";
import {
  AUTO_TERMINAL_THEME_ID,
  TERMINAL_THEME_GALLERY,
  findGalleryTheme,
  isDarkBackground,
} from "./gallery";
import { terminalThemes } from "./terminal-themes";

const HEX_RE = /^#[0-9a-f]{6}$/i;

const ANSI_CHANNELS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

describe("TERMINAL_THEME_GALLERY（内置画廊 8 套）", () => {
  it("简报定数：8 套（品牌双主题 + Dracula/Nord/Solarized 系 + One Dark/GitHub Light）", () => {
    expect(TERMINAL_THEME_GALLERY.map((t) => t.id)).toEqual([
      "ottr-light",
      "ottr-dark",
      "dracula",
      "nord",
      "solarized-dark",
      "solarized-light",
      "one-dark",
      "github-light",
    ]);
    // id 唯一（选择器键与持久化面都按 id）
    expect(new Set(TERMINAL_THEME_GALLERY.map((t) => t.id)).size).toBe(8);
  });

  it("逐套核对：ANSI 16 色全在位且为合法 #rrggbb；fg/bg/cursor/selection 通道齐备", () => {
    for (const def of TERMINAL_THEME_GALLERY) {
      const missing = ANSI_CHANNELS.filter((ch) => def.theme[ch] == null);
      expect([def.id, missing]).toEqual([def.id, []]);
      for (const ch of ANSI_CHANNELS) {
        expect([`${def.id}.${ch}`, HEX_RE.test(def.theme[ch] as string)]).toEqual([
          `${def.id}.${ch}`,
          true,
        ]);
      }
      for (const ch of ["foreground", "background", "cursor", "selectionBackground"] as const) {
        expect([`${def.id}.${ch}`, def.theme[ch] != null]).toEqual([`${def.id}.${ch}`, true]);
      }
    }
  });

  it("dark 标注与背景实际亮度一致（选择器明暗徽标的依据）", () => {
    for (const def of TERMINAL_THEME_GALLERY) {
      expect([def.id, def.dark]).toEqual([def.id, isDarkBackground(def.theme.background!)]);
    }
    // 亮暗两半都有（auto 提示按明暗分组的最低保障）
    expect(TERMINAL_THEME_GALLERY.filter((t) => t.dark).length).toBeGreaterThanOrEqual(4);
    expect(TERMINAL_THEME_GALLERY.filter((t) => !t.dark).length).toBeGreaterThanOrEqual(3);
  });

  it("品牌双主题与 terminalThemes 单源同引用（auto 与画廊条目不漂移）", () => {
    const light = findGalleryTheme("ottr-light");
    const dark = findGalleryTheme("ottr-dark");
    expect(light?.theme).toBe(terminalThemes.light);
    expect(dark?.theme).toBe(terminalThemes.dark);
  });

  it("findGalleryTheme：未知 id → undefined", () => {
    expect(findGalleryTheme(AUTO_TERMINAL_THEME_ID)).toBeUndefined();
    expect(findGalleryTheme("nope")).toBeUndefined();
  });

  it("知名主题锚点抽查（防手滑改错官方色值）", () => {
    const byId = (id: string) => findGalleryTheme(id)!.theme;
    expect(byId("dracula")).toMatchObject({ background: "#282a36", red: "#ff5555", brightBlack: "#6272a4" });
    expect(byId("nord")).toMatchObject({ background: "#2e3440", cyan: "#88c0d0", brightWhite: "#eceff4" });
    expect(byId("solarized-dark")).toMatchObject({ background: "#002b36", blue: "#268bd2", brightRed: "#cb4b16" });
    expect(byId("solarized-light")).toMatchObject({ background: "#fdf6e3", black: "#eee8d5", white: "#073642" });
    expect(byId("one-dark")).toMatchObject({ background: "#282c34", green: "#98c379" });
    expect(byId("github-light")).toMatchObject({ background: "#ffffff", red: "#d73a49", blue: "#0366d6" });
  });
});
