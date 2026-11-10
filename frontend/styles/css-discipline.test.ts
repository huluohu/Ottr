// CSS 纪律守卫（评审 2026-10-10 整改的防复发层；沿 tokens.test/dialogScroll.test
// 的「对样式源做文本断言」口径，数字即规约）：
//   1. 引用必须有定义——任何 var(--x) 的 x 必须在 tokens.css 或分节样式中定义
//      （或带 fallback）。历史事故：--shadow-overlay/--fg 共 13 处引用零定义，
//      浮层投影静默失效数月无人知。
//   2. 动效时长/缓动只允许引用 motion token（--dur*/--ease*/--toast-ttl），
//      字面值黑名单——收敛后不允许新字面值回流。
//   3. 圆角只允许 radius token（+50% 圆 / 0 直角）。
//   4. 字号只允许 text token（+1em 继承 / 16px 的 :root rem 基准锚点）。
import { describe, expect, it } from "vitest";
import { allAppCss } from "./all-css";
import tokensCss from "../theme/tokens.css?raw";

function allSources(): string {
  // tokens.css 单独 ?raw 引入；分节经 allAppCss（index.css 除外）。
  return tokensCss + "\n" + allAppCss();
}

describe("CSS 纪律守卫（评审整改防复发）", () => {
  it("每个 var(--x) 引用都有定义（或带 fallback）——杜绝失效引用静默回潜", () => {
    const src = allSources();
    const defined = new Set<string>();
    for (const m of src.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    const offenders: string[] = [];
    for (const m of allAppCss().matchAll(/var\((--[\w-]+)(\s*,[^)]*)?\)/g)) {
      const [, name, fallback] = m;
      if (!defined.has(name) && !fallback) offenders.push(name);
    }
    expect(offenders, `未定义的令牌引用: ${[...new Set(offenders)].join(", ")}`).toEqual([]);
  });

  it("动效时长/缓动零字面值——transition/animation 只引用 motion token", () => {
    const offenders: string[] = [];
    for (const line of allAppCss().split("\n")) {
      if (!/^\s*(transition|animation)\s*:/.test(line)) continue;
      if (line.includes("0.01ms")) continue; // reduced-motion 全局兜底（00-base）
      if (/\d(\.\d+)?(ms|s)\b/.test(line)) offenders.push(line.trim());
    }
    expect(offenders, `动效字面值回流:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("border-radius 只引用 radius token（50% 圆 / 0 直角除外）", () => {
    const offenders: string[] = [];
    for (const line of allAppCss().split("\n")) {
      const m = line.match(/^\s*border-radius:\s*([^;]+);/);
      if (!m) continue;
      const v = m[1].trim();
      if (v === "0" || v === "50%" || v.includes("var(--radius-")) continue;
      offenders.push(line.trim());
    }
    expect(offenders, `圆角字面值回流:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("font-size 只引用 text token（1em 继承 / 16px rem 基准锚点除外）", () => {
    const offenders: string[] = [];
    for (const line of allAppCss().split("\n")) {
      const m = line.match(/^\s*font-size:\s*([^;]+);/);
      if (!m) continue;
      const v = m[1].trim();
      if (v === "1em" || v === "inherit" || v === "16px" || v.includes("var(--text-")) continue;
      offenders.push(line.trim());
    }
    expect(offenders, `字号字面值回流:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("缓动关键字 ease 字面值回流（2026-10-16 全面评审 frontend-ui-low-1）：transition/animation 缓动只允许 motion token", () => {
    const offenders: string[] = [];
    for (const line of allAppCss().split("\n")) {
      if (!/^\s*(transition|animation)\s*:/.test(line)) continue;
      if (line.includes("0.01ms")) continue; // reduced-motion 兜底
      // 匹配独立的 ease 关键字（非 ease-in/ease-out/ease-in-out）
      if (/\bease\s*[,;]/.test(line) || line.trim().endsWith("ease")) {
        offenders.push(line.trim());
      }
    }
    expect(offenders, `缓动关键字 ease 回流:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("file-row 选中态选择器必须连 :hover 一起声明（2026-10-16 用户反馈：两选择器特异性同为 (0,2,0)，:hover 在后按序获胜盖掉选中高亮——悬停选中行高亮消失、移开才现形）", () => {
    const css = allAppCss();
    const idx = css.indexOf('.file-row[data-selected="true"]');
    expect(idx, "选中态规则存在").toBeGreaterThanOrEqual(0);
    const brace = css.indexOf("{", idx);
    const selectorList = css.slice(idx, brace);
    expect(
      selectorList,
      "选中高亮被 :hover 盖掉的回归防线：选择器列表须含 data-selected=true]:hover",
    ).toContain('.file-row[data-selected="true"]:hover');
  });

  it("字阶七档与动效 token 存在（结构锚）", () => {
    for (const key of [
      "--text-2xs",
      "--text-xs",
      "--text-sm",
      "--text-base",
      "--text-md",
      "--text-lg",
      "--text-xl",
      "--dur-fast",
      "--dur",
      "--dur-slow",
      "--ease-out",
      "--ease-in",
      "--ease-float",
      "--ease-drift",
      "--dur-ripple",
      "--dur-ripple-soft",
      "--shadow-1",
      "--shadow-2",
      "--shadow-3",
      "--radius-sm",
      "--radius-md",
      "--radius-lg",
      "--radius-xl",
      "--radius-pill",
      "--toast-ttl",
      "--z-ctx-hit",
      "--z-ctx-menu",
      "--z-ctx-sub",
      "--z-rail-backdrop",
    ]) {
      expect(tokensCss.includes(`${key}:`), `tokens.css 缺 ${key}`).toBe(true);
    }
  });

  it("右键菜单 z 小栈已入刻度（99/100/101 字面值清零）", () => {
    expect(allAppCss()).not.toMatch(/z-index:\s*(99|100|101);/);
  });

  // 2026-11-10 层级/尺寸纪律加固：此前守卫只断言「规则存在」，不校验值——
  // 这类回归（面板被挪出包裹层、min-height 回到 100%、z 刻度错序）会静默
  // 复现而 CI 全绿。这里把**值**与**相对顺序**钉死。
  describe("层级与尺寸契约（2026-11-10 审计加固）", () => {
    const css = allAppCss();
    const tokens = tokensCss;

    it("模态层必须盖住顶栏 / 右键菜单命中层 / 通知面板（否则模态开着时顶栏仍可点、右键菜单透明层吃掉工具行点击）", () => {
      const z = (name: string): number => {
        const m = tokens.match(new RegExp(`${name}:\\s*(\\d+)`));
        expect(m, `tokens.css 缺 ${name}`).not.toBeNull();
        return Number(m![1]);
      };
      const overlay = z("--z-overlay");
      expect(overlay).toBeGreaterThan(z("--z-topbar"));
      expect(overlay).toBeGreaterThan(z("--z-ctx-hit"));
      expect(overlay).toBeGreaterThan(z("--z-notify"));
      // 锁屏仍要盖住模态与 toast
      expect(z("--z-lock")).toBeGreaterThan(overlay);
      expect(z("--z-lock")).toBeGreaterThan(z("--z-toast"));
    });

    it("右键菜单命中层与本体必须都在模态之下（透明命中层盖住模态会让对话框点不动）", () => {
      const cssHit = css.match(/\.ctx-overlay \{[^}]*z-index: var\(--z-ctx-hit\)/s);
      expect(cssHit, "右键菜单透明命中层未用 --z-ctx-hit").not.toBeNull();
    });

    it("终端行让位必须折叠成 0 高（flex: 0 0 0px）——值错则面板被均分成半屏", () => {
      expect(css).toMatch(/\.term-main-row\[data-yield="true"\]\s*\{[^}]*flex:\s*0 0 0px/s);
    });

    it("主区左列必须是 flex 列容器且 min-height:0（缺一项则终端行 flex:1 失效、内容区塌陷）", () => {
      expect(css).toMatch(/\.main-area-body \{[^}]*display: flex[^}]*flex-direction: column/s);
      expect(css).toMatch(/\.main-area-body \{[^}]*min-height: 0/s);
    });

    it("工作区视图外壳不得用 min-height:100%（相对错误的包含块会撑出容器、压住上方工具行）", () => {
      expect(css).toMatch(/\.workspace-view \{[^}]*min-height: 0/s);
      expect(css).not.toMatch(/\.workspace-view \{[^}]*min-height: 100%/s);
    });

    it("视图外壳正文必须是 flex 列容器（子面板的 flex:1 依赖它，否则静默失效）", () => {
      expect(css).toMatch(/\.wv-body \{[^}]*display: flex[^}]*flex-direction: column/s);
    });

    it("不可见的行内按钮必须 pointer-events:none（隐形却可命中 → 误触删除/打开访达）", () => {
      expect(css).toMatch(/\.recording-actions \{[^}]*opacity: 0[^}]*pointer-events: none/s);
    });

    it("终端行必须是定位上下文（隐藏 holder 的包含块正确 → 切视图不再给远端发假 SIGWINCH）", () => {
      expect(css).toMatch(/\.term-main-row \{[^}]*position: relative/s);
    });
  });

  it("字段标签堆叠契约（2026-10-15 用户反馈：CronPanel 脚本域 textarea 与标签内联崩坏——.grow 是零定义死类名，form-row 内靠控件 width:100% 换行假象兜底，行外裸露即崩）：三处规则必须在位", () => {
    const css = allAppCss();
    expect(css.includes("label.grow {"), "label.grow 契约定义缺失（死类名回流）").toBe(true);
    expect(css.includes(".jump-form > label {"), "jump-form 链名称字段标签规则缺失").toBe(true);
    expect(css.includes(".lock-card > label {"), "lock-card 主密码字段标签规则缺失").toBe(true);
  });

  it("wizard-step 满宽规则必须排除勾选类控件（2026-10-15 用户反馈：告警规则「订阅渠道」勾选框拉成满宽蓝杠；settings-row 开关 34px 补丁为同病先例——ui-checkbox/ui-switch 均为 input[type=checkbox]）", () => {
    const css = allAppCss();
    expect(
      css.includes(".wizard-step input:not([type=\"checkbox\"])"),
      "wizard-step input 满宽规则未排除 checkbox——勾选框/开关将再被拉成通栏",
    ).toBe(true);
  });

  // 2026-11-02 低危整改批次（UI/本地化）：以下几处曾各自出过一次可见缺陷，
  // 结构性钉死，防回流。
  describe("低危整改批次守卫（2026-11-02）", () => {
    const css = allAppCss();

    it("AI 面板宽度按主区百分比（2026-11-10 审计：vw 是视口宽，视口里还站着图标轨+侧栏 → 面板把终端列压窄、视图切换钮被推出可视区）", () => {
      expect(css).toMatch(/\.ai-panel \{[^}]*width: min\(400px, 38%\)/s);
      expect(css).toMatch(/\.ai-panel \{[^}]*min-width: min\(280px, 38%\)/s);
      // 不得回退到 vw 口径（那正是「工具行点不动」的成因之一）
      expect(css).not.toMatch(/\.ai-panel \{[^}]*38vw/s);
    });

    it("markdown 内容层横向滚动（宽表自己滚，不撑破 400px 面板）", () => {
      expect(css).toMatch(/\.ai-answer-text \{[^}]*overflow-x: auto/s);
      // 容器不得再 pre-wrap：react-markdown 的块间 \"\\n\" 文本节点会被渲染成
      // 整行空行（段落/列表之间多一行空白）。
      expect(css).toMatch(/\.ai-answer-text \{[^}]*white-space: normal/s);
      expect(css).not.toMatch(/\.ai-answer-text \{[^}]*white-space: pre-wrap/s);
      // 容器改 normal 后，代码块必须自带保留换行（否则代码被压成一行）。
      expect(css).toMatch(/\.ai-answer-text pre \{[^}]*white-space: pre/s);
    });

    it("known_hosts 工具条允许换行（按钮多 + 标签随语言变长，640px 弹窗挤爆）", () => {
      expect(css).toMatch(/\.kh-toolbar \{[^}]*flex-wrap: wrap/s);
    });

    it("about 外链规则只有一份（前一块被后一块整块覆盖 = 死代码回流）", () => {
      // 行首锚定：`.about-link-label {` 是 `.about-link-primary .about-link-label {`
      // 的子串，不锚定会把后者误计成第二份。
      for (const sel of [".about-links {", ".about-link-line {", ".about-link-label {"]) {
        const n = (css.match(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gm")) ?? []).length;
        expect(n, `${sel} 出现 ${n} 次——重复声明即死代码`).toBe(1);
      }
      // display:contents 的父级下标签是 grid item，flex:none 无效。
      expect(css).not.toMatch(/\.about-link-label \{[^}]*flex: none/s);
    });

    it("赞助链接不用 danger 红（红=危险/删除，与「支持」语义相反且暗色对比度不足）", () => {
      expect(css).toMatch(/\.about-link-primary a \{[^}]*color: var\(--color-accent-text\)/s);
      expect(css).not.toMatch(/\.about-link-primary a \{[^}]*--color-danger/s);
    });

    it("验证码刷新钮不自造外观（沿用既有 .btn 变体：圆角/描边/hover 归全局）", () => {
      expect(css).not.toMatch(/\.prompt-code-refresh \{[^}]*border-radius/s);
      expect(css).not.toMatch(/\.prompt-code-refresh \{[^}]*background/s);
      expect(css).not.toMatch(/\.prompt-code-refresh:hover/s);
    });

    it("验证码过期态：纯 danger 文字、**不加半透明底色**（加了会把亮色拖出 AA）", () => {
      // 实算：tokens 校准后 danger 在 overlay 上亮 5.27:1 / 暗 5.80:1（过 AA）；
      // 再叠 12% danger 半透明底色 → 亮 4.39 / 暗 4.91（亮色掉出 AA）。
      expect(css).toMatch(/\.prompt-code-expired \{[^}]*color: var\(--color-danger\)/s);
      expect(css).not.toMatch(
        /\.prompt-code-expired \{[^}]*color-mix\([^}]*var\(--color-danger\)[^}]*\}/s,
      );
    });

    it("交互式认证弹窗的长主机名折行（440px 弹窗不横向溢出）", () => {
      expect(css).toMatch(/\.prompt-dialog \.dialog-intro \{[^}]*overflow-wrap: anywhere/s);
    });

    it("空间/圆角令牌不留 fallback（tokens.css 全有定义，带 fallback 是冗余写法）", () => {
      expect(css).not.toMatch(/var\(--space-\d+,/);
      expect(css).not.toMatch(/var\(--radius-[a-z]+,/);
    });

    it("更新状态行的动作钮不参与收缩、错误文案可断行（2026-11-03 用户反馈「按钮都变形了」：reqwest 原始报错是一整句带 URL 的长串，在 flex 行里把「检查更新」按钮压到文字宽度不足 → 文字竖排成两行；同 MCP 授权行「勾选文字被挤成竖排」的同一病根）", () => {
      expect(css).toMatch(/\.update-status-row > button \{[^}]*flex: none/s);
      expect(css).toMatch(/\.update-status-row > button \{[^}]*white-space: nowrap/s);
      expect(css).toMatch(/\.update-status-row > \.form-error \{[^}]*min-width: 0/s);
      expect(css).toMatch(/\.update-status-row > \.form-error \{[^}]*overflow-wrap: anywhere/s);
    });
  });
});
