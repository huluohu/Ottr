// CSS 契约守卫（ui-batch2 Task 1，审计 48/49「文件/进程视图列表空+终端透出」）。
//
// 根因（真窗 DOM 取证钉死，证据 /tmp/ui2-t1/evidence-dom-files-view.txt）：
// 隐藏 holder `.term-area-holder[data-hidden="true"]` 是 absolute inset:0 的
// positioned 元素，恒盖在 in-flow 兄弟面板（FilePanel/ProcessBrowser）之上；
// 其内活动 pane 又被 `.term-pane[data-active="true"] { visibility: visible }`
// 戳穿（visibility 可被后代逐元素翻回），不透明 xterm 画布于是整面盖住面板——
// 面板数据其实已在 DOM（sftp_realpath 返回 /home/spike、file-row 十行在册），
// 是绘制层被吞，不是数据链路断。仅自建 stacking context 的元素（disabled
// 按钮 opacity:.5、proc 表头 sticky+z-index）画在 pane 之上，即审计 48 的
// 「悬空四按钮」与 49 的「孤儿表头」。
//
// 本守卫钉死两条修复规则不回退：
//  1. 隐藏 holder 内的 pane 一律 visibility:hidden（特异性 0,3,0 压过
//     .term-pane[data-active] 的 0,2,0）——终端缓冲不再透过面板显形；
//  2. term-main-row 的 data-yield 折叠规则存在（files/procs 视图行不再
//     flex:1 与面板 50/50 均分主区）。
// 局限说明（沿 ui-no-native-controls 先例）：grep 式文本扫描防「规则被顺手
// 删/改名」这一主要复发路径；几何级语义仍靠真窗截图与布局回归兜底。
import { describe, expect, it } from "vitest";
import { allAppCss } from "../styles/all-css";

const css = allAppCss();

describe("term 隐藏面 CSS 契约（ui2 T1，审计 48/49 守卫）", () => {
  it("隐藏 holder 内 pane 一律 visibility:hidden（压过 data-active 翻回）", () => {
    expect(css).toContain('.term-area-holder[data-hidden="true"] .term-pane');
    const rule = css.slice(css.indexOf('.term-area-holder[data-hidden="true"] .term-pane'));
    expect(rule.slice(0, 200)).toContain("visibility: hidden");
  });

  it("term-main-row 的 data-yield 折叠规则在册", () => {
    expect(css).toContain('.term-main-row[data-yield="true"]');
    const rule = css.slice(css.indexOf('.term-main-row[data-yield="true"]'));
    expect(rule.slice(0, 200)).toContain("flex:");
  });
});
