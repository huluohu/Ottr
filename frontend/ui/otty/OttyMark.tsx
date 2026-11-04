// Otty 球共享 mark（Ask Ottr Task 4 自 IconRail.tsx 抽出）：应用图标同构小样
// ——teal 渐变底盘上墨色呆毛獭头（奶油宽吻 + 琥珀鼻 + 宽距豆豆眼）。
//
// 【为何抽取】Ask Ottr 悬浮球（ai/AskOttrOrb）与图标轨设置入口（app/IconRail）
// 用同一个 mark——「提取既有 mark，不重绘官方品牌」（plan Task 4 红线）：
// 两处各画一份迟早漂移，brand 资产（brand/*.svg、public/icon.svg）是官方
// 全尺寸版，桌面 UI 需要的是这个 32 viewBox 微缩同构版。
//
// 【为何 useId】原 OttyBall 把渐变/裁剪 id 写死（otty-ball-plate/-clip）——
// 同页第二个实例一渲染，两份 svg 的 defs id 撞车，url(#...) 全解析到文档里
// 第一份（球色随它跑）。React useId() 生成实例唯一 id（消毒非字母数字后仍
// 保唯一），多实例共存零碰撞。
//
// 底盘恒为品牌 teal，任何主题下与载体都有对比（2026-10-16 用户反馈：墨色脸
// 在深色主题撞色）。品牌资产场景直引 brand 色板（tokens.css 消费纪律的品牌
// 资产豁免），size 可调（图标轨 26 / 悬浮球 32），几何以 32 viewBox 等比缩放。
import { useId } from "react";

export interface OttyMarkProps {
  /** 渲染边长（正方形等比；viewBox 32）。缺省 26 = 图标轨原尺寸（像素级一致）。 */
  size?: number;
}

export function OttyMark({ size = 26 }: OttyMarkProps) {
  // useId 原值含「:」（React 18）或「«»」（React 19）——url(#...) 引用与
  // querySelector 都嫌标点，消毒成字母数字；去标点后前缀序列仍实例唯一。
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const plateId = `otty-mark-plate-${uid}`;
  const clipId = `otty-mark-clip-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={plateId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2DD4BF" />
          <stop offset="1" stopColor="#0B7C6E" />
        </linearGradient>
        <clipPath id={clipId}>
          <circle cx="16" cy="16" r="14.5" />
        </clipPath>
      </defs>
      <circle cx="16" cy="16" r="14.5" fill={`url(#${plateId})`} />
      <g clipPath={`url(#${clipId})`}>
        {/* 呆毛 */}
        <path d="M15.4 5.2 C 14.4 3.4 14.9 2 16.7 1.4 C 15.7 3 15.9 4.4 16.8 5.5 Z" fill="#0F172A" />
        {/* 双耳 */}
        <circle cx="8.2" cy="8.6" r="2.6" fill="#0F172A" />
        <circle cx="23.8" cy="8.6" r="2.6" fill="#0F172A" />
        {/* 宽圆头（微倾） */}
        <g transform="rotate(-3 16 18)">
          <path d="M 8.2 27.5 L 8.2 17.2 C 8.2 10 11.5 6.8 16 6.8 C 20.5 6.8 23.8 10 23.8 17.2 L 23.8 27.5 Z" fill="#0F172A" />
          {/* 奶油宽吻 + 琥珀鼻 */}
          <rect x="10.4" y="17.4" width="11.2" height="3.8" rx="1.9" fill="#F6E7D4" />
          <rect x="13.9" y="16.6" width="4.2" height="2" rx="1" fill="#F59E0B" />
          {/* 宽距豆豆眼（歪头一高一低） */}
          <circle cx="11.4" cy="14" r="1.2" fill="#0F172A" />
          <circle cx="20.6" cy="13.4" r="1.2" fill="#0F172A" />
        </g>
        {/* 白水线 */}
        <rect x="1.5" y="24.2" width="29" height="1.6" fill="#FFFFFF" opacity="0.9" />
      </g>
    </svg>
  );
}
