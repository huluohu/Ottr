// OttyMark 单测（Ask Ottr Task 4）：抽取共享 mark 的核心回归面——多实例
// 渐变/裁剪 id 不撞车（原 IconRail 内联 OttyBall 写死 id，渲染两份即互相
// 劫持 url(#) 引用）；几何以 32 viewBox 等比缩放（缺省 26 = 图标轨原尺寸）。
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OttyMark } from "./OttyMark";

afterEach(() => {
  cleanup();
});

describe("OttyMark（共享 Otty 球 mark）", () => {
  it("两个实例的渐变/裁剪 id 互不相同（useId 实例唯一，url(#) 不再互相劫持）", () => {
    const { container } = render(
      <>
        <OttyMark />
        <OttyMark />
      </>,
    );
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    const ids = [...svgs].flatMap((s) =>
      [...s.querySelectorAll("linearGradient, clipPath")].map((n) => n.id),
    );
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    // 每个实例的 url(#) 引用都指向自己那份 defs（断言引用前缀各归各主）
    svgs.forEach((s) => {
      const ownIds = new Set(
        [...s.querySelectorAll("linearGradient, clipPath")].map((n) => n.id),
      );
      const refs = [...s.querySelectorAll("[fill^='url('], [clip-path]")].map((n) =>
        n.getAttribute("fill") ?? n.getAttribute("clip-path") ?? "",
      );
      expect(refs.length).toBeGreaterThanOrEqual(2);
      for (const r of refs) {
        const id = r.replace(/^url\(#/, "").replace(/\)$/, "");
        expect(ownIds.has(id), `引用 ${r} 不在本实例 defs 内`).toBe(true);
      }
    });
  });

  it("缺省 26px（IconRail 像素级一致）；size prop 等比换算（悬浮球 32）", () => {
    const { container, rerender } = render(<OttyMark />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("26");
    expect(svg?.getAttribute("height")).toBe("26");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 32 32");
    rerender(<OttyMark size={32} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("32");
  });
});
