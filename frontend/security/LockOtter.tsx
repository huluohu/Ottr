// LockOtter（2026-10-16 用户需求：锁屏弹框加「贪玩被拦在门外的小水獭」形象
// 动画）：吉祥物 Otty 的锁屏亮相——贪玩晚归被关在门外，从门沿探出头、两爪
// 扒沿、眨眼等主人输密码开门；头顶还挂着玩出来的一枚草叶（贪玩的证物）。
//
// 视觉层次（SVG 文档序 = z 序）：头部组在最底（门沿墙之后可藏身）→ 门沿墙
// （延伸到画布底的门槛）→ 两爪（墙前，扒住沿口）。peek/duck 的 translateY
// 只作用头部组：入场从墙后探头；密码输错缩回墙后（耳朵尖还露着偷看）。
//
// 动效契约（全部 token 驱动，css-discipline 守卫；reduced-motion 由 00-base
// 全局兜底——动画趋零后停在自然位=完整可见）：
//   * 入场 otter-peek：从门沿下一次性探头（--dur-otter-peek，--ease-out）；
//   * 密码输错：errorNonce 递增 → svg 重挂，otter-lift 换 otter-duck（缩回
//     墙后再探头的「挨说了」一次性反应；store 每次 unlock 前清 error，
//     逐次失败逐次触发）；
//   * 待机：呼吸浮动（alternate 往复）、眨眼错拍、左右爪交替轻拍门沿、
//     头顶草叶缓摆；
//   * 解锁在途（mood=eager）：呼吸加速一倍（期待感）。
// 纯装饰（aria-hidden），不新增词典键；配色全走品牌保留色 token（brand.md：
// 毛色 --ottr-fur-600/800、吻部 --ottr-cream-100、墨色五官 --ottr-ink-900，
// 腮红用点缀色 --ottr-amber-500、草叶用主色系 --color-success）。
export function LockOtter({
  mood,
  errorNonce,
}: {
  mood: "idle" | "eager";
  /** 密码错误次数（含空密码本地拦截）：驱动 duck 重挂；0 = 首次挂载播 peek。 */
  errorNonce: number;
}) {
  return (
    <div
      className={`lock-otter${mood === "eager" ? " eager" : ""}`}
      data-mood={mood}
      data-testid="lock-otter"
      aria-hidden="true"
    >
      {/* key=errorNonce：错误时重挂 svg，一次性动画（peek/duck）得以重播 */}
      <svg
        key={errorNonce}
        className={errorNonce > 0 ? "lock-otter-svg duck" : "lock-otter-svg"}
        viewBox="0 0 200 128"
        role="presentation"
        focusable="false"
      >
        {/* 头部（藏身层）：peek/duck 的 translateY 在 otter-lift 上，呼吸在内层 */}
        <g className="otter-lift">
          <g className="otter-body">
            {/* 耳（外圈毛色 + 内耳暗部） */}
            <circle cx="70" cy="34" r="9" className="ottr-fur" />
            <circle cx="130" cy="34" r="9" className="ottr-fur" />
            <circle cx="70" cy="35" r="4.2" className="ottr-fur-dark" />
            <circle cx="130" cy="35" r="4.2" className="ottr-fur-dark" />
            {/* 头顶草叶（贪玩的证物）：茎 + 叶，左右缓摆 */}
            <g className="otter-leaf">
              <path d="M118 28 Q117 20 113 15" className="otter-leaf-stem" />
              <path
                d="M113 15 Q120 6 128 9 Q126 18 116 18 Q113 17 113 15 Z"
                className="otter-leaf-blade"
              />
            </g>
            {/* 头 */}
            <ellipse cx="100" cy="60" rx="37" ry="33" className="ottr-fur" />
            {/* 腮红（点缀色轻敷） */}
            <ellipse cx="74" cy="66" rx="6" ry="3.6" className="otter-blush" />
            <ellipse cx="126" cy="66" rx="6" ry="3.6" className="otter-blush" />
            {/* 吻部 + 鼻 + 「w」嘴 */}
            <ellipse cx="100" cy="72" rx="18" ry="12.5" className="ottr-cream" />
            <ellipse cx="100" cy="64" rx="4.6" ry="3.4" className="ottr-ink" />
            <path
              d="M100 68 Q100 72 95.5 72.5 M100 68 Q100 72 104.5 72.5"
              className="otter-mouth"
            />
            {/* 眼（整组缩放做眨眼） + 高光 */}
            <g className="otter-eyes">
              <circle cx="84" cy="54" r="4.8" className="ottr-ink" />
              <circle cx="116" cy="54" r="4.8" className="ottr-ink" />
              <circle cx="82.6" cy="52.6" r="1.4" className="ottr-glint" />
              <circle cx="114.6" cy="52.6" r="1.4" className="ottr-glint" />
            </g>
            {/* 眉毛两撇（静态可爱值；期待感由 eager 态呼吸加速承担） */}
            <path d="M78 46 Q84 43.5 90 45.4" className="otter-brow" />
            <path d="M110 45.4 Q116 43.5 122 46" className="otter-brow" />
            {/* 胡须 */}
            <g className="otter-whiskers">
              <path d="M80 68 Q66 66 58 62" />
              <path d="M80 72 Q66 72 57 71" />
              <path d="M120 68 Q134 66 142 62" />
              <path d="M120 72 Q134 72 143 71" />
            </g>
          </g>
        </g>
        {/* 门沿墙（藏身处）：上缘圆角、延伸到画布底 */}
        <path
          className="otter-door-edge"
          d="M0 128 V92 Q0 86 6 86 H194 Q200 86 200 92 V128 Z"
        />
        {/* 两爪扒沿（墙前层，各自轻拍节拍错开） */}
        <g className="otter-paw otter-paw-l">
          <rect x="64" y="76" width="19" height="22" rx="8.5" className="ottr-fur" />
          <path d="M70 80 v6 M76 80 v6" className="otter-paw-line" />
        </g>
        <g className="otter-paw otter-paw-r">
          <rect x="117" y="76" width="19" height="22" rx="8.5" className="ottr-fur" />
          <path d="M123 80 v6 M129 80 v6" className="otter-paw-line" />
        </g>
      </svg>
    </div>
  );
}
