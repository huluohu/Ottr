// releaseNotes 单测（2026-10-26 图标轨更新面板）：markdown 极简结构解析 +
// 行内标记剥离 + 占位说明判定。
import { describe, expect, it } from "vitest";
import { isPlaceholderNotes, parseReleaseNotes, stripInline } from "./releaseNotes";

describe("releaseNotes（发布说明解析）", () => {
  it("占位「Ottr x.y.z」/空/缺省 = 无说明", () => {
    expect(isPlaceholderNotes("Ottr 1.5.8", "1.5.8")).toBe(true);
    expect(isPlaceholderNotes("  Ottr 1.5.8\n", "1.5.8")).toBe(true);
    expect(isPlaceholderNotes("", "1.5.8")).toBe(true);
    expect(isPlaceholderNotes(null, "1.5.8")).toBe(true);
    expect(isPlaceholderNotes(undefined, "1.5.8")).toBe(true);
    expect(isPlaceholderNotes("Ottr 1.5.9", "1.5.8")).toBe(false); // 版本不符不算占位
    expect(parseReleaseNotes("Ottr 1.5.8", "1.5.8")).toEqual([]);
  });

  it("标题 / 列表 / 段落分块，空行跳过，行内标记剥成纯文本", () => {
    const body = [
      "## 🔄 1.5.8：立即同步弹框体验优化",
      "",
      "- **立即同步弹框排版更紧凑**：弹窗自适应内容高度",
      "* 第二条 `code` 项",
      "• 第三条（圆点也算）",
      "详见 [发布页](https://github.com/huluohu/Ottr/releases) 与 __强调__。",
      "### 子标题",
    ].join("\n");
    expect(parseReleaseNotes(body, "1.5.8")).toEqual([
      { kind: "heading", text: "🔄 1.5.8：立即同步弹框体验优化" },
      { kind: "bullet", text: "立即同步弹框排版更紧凑：弹窗自适应内容高度" },
      { kind: "bullet", text: "第二条 code 项" },
      { kind: "bullet", text: "第三条（圆点也算）" },
      { kind: "para", text: "详见 发布页 与 强调。" },
      { kind: "heading", text: "子标题" },
    ]);
  });

  it("stripInline：链接只留文本（含图片链接），粗体/代码去包裹符，不碰普通星号组合", () => {
    expect(stripInline("看 [这里](https://x.y/z) 和 ![图](https://x.y/i.png)")).toBe("看 这里 和 图");
    expect(stripInline("**粗** `code` __下划__")).toBe("粗 code 下划");
    expect(stripInline("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("CRLF 换行同样可解析", () => {
    expect(parseReleaseNotes("# A\r\n- b\r\n", "0.0.0")).toEqual([
      { kind: "heading", text: "A" },
      { kind: "bullet", text: "b" },
    ]);
  });
});
