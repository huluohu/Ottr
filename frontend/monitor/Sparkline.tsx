// SVG sparkline（Phase 3 Task 1，B4 上半）：零依赖手写 polyline 迷你图。
// 坐标换算是纯函数（sparklinePoints，可测面）；组件只包一层 <svg>。
// 主题纪律：颜色/线宽走 CSS（App.css .monitor-spark-*），组件不持色值。
import { useId } from "react";

/**
 * 数列 → polyline `points` 属性串。等宽分布 x∈[0,width]，y 按 max 归一
 * （max 缺省取数列峰值，峰值 ≤0 时兜底 1 防除零）。单点画在左下与峰值处
 * 的折线起点（x=0）；空数列返回空串（组件不渲染线）。
 */
export function sparklinePoints(
  values: number[],
  width: number,
  height: number,
  max?: number,
): string {
  const n = values.length;
  if (n === 0 || width <= 0 || height <= 0) return "";
  const peak = max ?? Math.max(...values);
  const top = peak > 0 ? peak : 1;
  const stepX = n > 1 ? width / (n - 1) : 0;
  return values
    .map((v, i) => {
      const x = i * stepX;
      const ratio = Math.min(Math.max(v / top, 0), 1);
      const y = height - ratio * height;
      return `${round2(x)},${round2(y)}`;
    })
    .join(" ");
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 迷你折线图（无坐标轴/无交互，侧栏指标行的缩略趋势面）。
 * `max` 固定口径时传入（百分比传 100——不同窗口峰值不同，纵轴语义要稳定）。
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  max,
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  max?: number;
  /** 无障碍名（aria-label；图表本身对屏幕阅读器以标签概括）。 */
  label?: string;
}) {
  const gradId = useId();
  const points = sparklinePoints(values, width, height, max);
  if (!points) {
    return (
      <svg
        className="monitor-spark"
        data-testid="monitor-spark-empty"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
      />
    );
  }
  return (
    <svg
      className="monitor-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="monitor-spark-fill-strong" />
          <stop offset="100%" className="monitor-spark-fill-faint" />
        </linearGradient>
      </defs>
      {/* 面积填充（基线到底）+ 折线：同一 polyline 派生，无额外数据结构 */}
      <polygon
        className="monitor-spark-area"
        points={`0,${height} ${points} ${width},${height}`}
        fill={`url(#${gradId})`}
      />
      <polyline
        className="monitor-spark-line"
        points={points}
        fill="none"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
