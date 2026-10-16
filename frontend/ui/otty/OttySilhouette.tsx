// OttySilhouette（2026-10-16 视觉重设计 M3）：空态 Otty 小剪影位（报告 §4
// 「每个空态配一枚 Otty 小剪影位，占位 48px，统一 SVG sprite」）。v5 同构
// 单源：墨色獭体剪影（头圆 + 胶囊 + 弯钩尾）+ 水线镂空 + Amber 鼻一点。
// 配色走品牌保留色 token（LockOtter 同纪律）；aria-hidden 纯装饰。
export function OttySilhouette({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className="otty-silhouette"
      aria-hidden="true"
    >
      {/* 弯钩尾 */}
      <path
        d="M47 40 C 55 40.5 59 36 58.5 29"
        fill="none"
        className="otty-sil-ink"
        strokeWidth="5"
        strokeLinecap="round"
      />
      {/* 胶囊身 */}
      <rect x="10" y="31" width="42" height="17" rx="8.5" className="otty-sil-ink" />
      {/* 头圆 + 奶油脸盘 + 豆豆眼 + 琥珀鼻 */}
      <circle cx="19" cy="26" r="13" className="otty-sil-ink" />
      <ellipse cx="16" cy="30" rx="8.6" ry="7.8" className="otty-sil-cream" />
      <path
        d="M9.8 24.4 C 9.8 23 11 22.3 12 22.9 C 12.6 23.2 13.2 23.2 13.8 22.9 C 14.8 22.3 16 23 16 24.4 C 16 26.3 14.6 27.7 12.9 27.7 C 11.2 27.7 9.8 26.3 9.8 24.4 Z"
        className="otty-sil-amber"
      />
      <ellipse cx="9.4" cy="29.2" rx="1.5" ry="1.8" className="otty-sil-ink" />
      <ellipse cx="21.8" cy="28.5" rx="1.5" ry="1.8" className="otty-sil-ink" />
      {/* 水线（镂空白缝的语义等价：亮色fg 淡线横过） */}
      <path
        d="M2 52 C 14 50 26 54 38 52 C 48 50.5 56 52.5 62 51.5"
        fill="none"
        stroke="var(--border-subtle)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
