// Sparkline 测试（Phase 3 Task 1 Step 3）：坐标换算纯函数 + SVG 渲染形态。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sparkline, sparklinePoints } from "./Sparkline";

afterEach(cleanup);

describe("sparklinePoints", () => {
  it("maps values to bottom-up coordinates across width", () => {
    // 0→底、50→半高、100→顶（max=100，height=100）
    expect(sparklinePoints([0, 50, 100], 200, 100, 100)).toBe("0,100 100,50 200,0");
  });

  it("normalizes by series peak when max omitted", () => {
    // 峰值 8 → 8 映射到顶（y=0），4 → 半高
    expect(sparklinePoints([4, 8], 100, 100)).toBe("0,50 100,0");
  });

  it("handles flat, single and empty series", () => {
    // 全零：top 兜底 1，不除零（画在底部）
    expect(sparklinePoints([0, 0], 10, 10)).toBe("0,10 10,10");
    // 单点：x=0
    expect(sparklinePoints([5], 10, 10, 10)).toBe("0,5");
    expect(sparklinePoints([], 10, 10)).toBe("");
    // 值超出 max：夹取到顶（扰动不越界）
    expect(sparklinePoints([120], 10, 10, 100)).toBe("0,0");
  });
});

describe("Sparkline component", () => {
  it("renders polyline with points and empty placeholder", () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} width={100} height={50} max={3} />);
    const poly = container.querySelector("polyline");
    expect(poly).not.toBeNull();
    // 1/3 高度 → y = 50 − 16.67 = 33.33（max 固定口径，纵轴语义稳定）
    expect(poly?.getAttribute("points")).toBe("0,33.33 50,16.67 100,0");

    render(<Sparkline values={[]} />);
    expect(screen.getByTestId("monitor-spark-empty")).toBeTruthy();
  });
});
