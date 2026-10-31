// InfoHint（2026-10-31 用户需求：设置页说明文案改「ⓘ 图标 + 悬停说明」形态）：
// 系统设置类应用通行做法——行内只留标签与控件，说明文字收进 ⓘ 气泡，界面从
// 「满屏说明段落」变回「一行一选项」。
//
// 判定口径（与本次改造同步落库，避免误伤）：
//   * 静态解释（「这个开关是干什么的」）→ ⓘ 气泡；
//   * 动态状态（已连接/进度/测试结果/空态提示）→ 保留可见文案——状态是信息
//     本身，藏进气泡等于藏掉信息。
//
// 气泡走 portal + fixed 定位（2026-10-31 真机验收）：设置窗壳是
// overflow:hidden 的固定高度浮层，绝对定位的气泡会被裁掉；挂到 body 上按
// 视口坐标摆，既不被裁剪，也不会给窗体撑出横向滚动条。
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface InfoHintProps {
  /** 说明正文（静态解释句）。 */
  text: string;
  /** 无障碍名（气泡触发器的可读名称），缺省用 text 前 40 字。 */
  label?: string;
  testid?: string;
}

/** 气泡最大宽度（CSS px）——与参考版式的说明气泡同量级。 */
const BUBBLE_MAX_W = 320;
/** 气泡与视口边缘的最小留白。 */
const EDGE = 12;

export function InfoHint({ text, label, testid }: InfoHintProps) {
  const id = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const accessible = label ?? text.slice(0, 40);

  /** 摆在触发器下方；右侧放不下则贴右缘；下方也放不下则翻到上方。 */
  const place = useCallback(() => {
    const btn = btnRef.current?.getBoundingClientRect();
    if (!btn) return;
    const bubble = bubbleRef.current?.getBoundingClientRect();
    const w = bubble?.width ?? BUBBLE_MAX_W;
    // 右对齐到徽标右缘：气泡向左铺开，压的是标签文字而不是旁边的控件
    // （开关被盖住时用户无法点它去试那个开关）。
    let left = btn.right - w;
    if (left < EDGE) left = EDGE;
    if (left + w > window.innerWidth - EDGE) left = Math.max(EDGE, window.innerWidth - EDGE - w);
    let top = btn.bottom + 8;
    const h = bubble?.height ?? 40;
    if (top + h > window.innerHeight - EDGE) top = Math.max(EDGE, btn.top - h - 8);
    setPos({ left, top });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onScroll = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  const show = useCallback(() => {
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <span className="info-hint" data-testid={testid}>
      <button
        type="button"
        ref={btnRef}
        className="info-hint-trigger"
        aria-label={accessible}
        aria-describedby={id}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === "Escape") hide();
          // 徽标常落在 <label class="settings-row"> 内——不拦住的话，点 ⓘ 会连带
          // 激活标签关联的控件（下拉/单选被顺手打开）。徽标自己只负责显示气泡。
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <span aria-hidden="true">i</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <span
            ref={bubbleRef}
            className="info-hint-bubble"
            id={id}
            role="tooltip"
            style={{ left: pos.left, top: pos.top }}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
