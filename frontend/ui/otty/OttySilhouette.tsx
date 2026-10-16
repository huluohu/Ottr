// OttySilhouette（2026-10-16 视觉重设计 M3）：空态 Otty 小剪影位（报告 §4
// 「每个空态配一枚 Otty 小剪影位，占位 48px，统一 SVG sprite」）。2026-10-16
// 定稿适配：C2-F5 基因——水面探头 + 双爪扒沿 + 呆毛 + 白水线（f5 托盘剪影
// 的彩色微缩，品牌保留色 token 上色）。
export function OttySilhouette({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className="otty-silhouette"
      aria-hidden="true"
    >
      {/* 呆毛 */}
      <path d="M31 6.6 C 29.8 4.4 30.4 2.8 32.6 2 C 31.4 4 31.6 5.6 32.8 7 Z" className="otty-sil-ink" />
      {/* 双耳 */}
      <circle cx="22.5" cy="15.3" r="2.5" className="otty-sil-ink" />
      <circle cx="41.5" cy="15.3" r="2.5" className="otty-sil-ink" />
      {/* 宽圆头（微倾一 signals） */}
      <path d="M 21 44 L 21 26 C 21 17.6 24.4 14 32 14 C 39.6 14 43 17.6 43 26 L 43 44 Z" className="otty-sil-ink" />
      {/* 双爪扒沿（C2 基座） */}
      <rect x="13" y="24.5" width="6" height="12.8" rx="3" className="otty-sil-ink" />
      <rect x="45" y="24.5" width="6" height="12.8" rx="3" className="otty-sil-ink" />
      {/* 奶油宽吻 + 琥珀鼻 */}
      <rect x="24" y="28" width="16" height="5.4" rx="2.7" className="otty-sil-cream" />
      <rect x="29" y="27" width="6" height="2.9" rx="1.45" className="otty-sil-amber" />
      {/* 宽距豆豆眼（歪头） */}
      <circle cx="26.2" cy="22.5" r="1.7" className="otty-sil-ink" />
      <circle cx="38.2" cy="21.9" r="1.7" className="otty-sil-ink" />
      {/* 白水线 + 水面 */}
      <rect x="2" y="45.8" width="60" height="1.6" fill="#FFFFFF" opacity="0.9" />
      <rect x="2" y="47.4" width="60" height="16.6" fill="var(--surface-raised)" />
    </svg>
  );
}
