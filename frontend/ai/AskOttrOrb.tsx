// Ask Ottr 悬浮球（Ask Ottr Task 4）：终端视图里的常驻 AI 提问入口。
//
// 【可见性门（全部订阅，隐藏即卸载——卸载的按钮不可聚焦，符合 a11y 门）】
//   mainView === terminal ∧ orb 开（enabled === true；null 未加载也隐藏防闪）
//   ∧ 聚焦 pane 有活目标（resolveFocusedTerminal + captureAiTarget +
//     isAiTargetLive 五元复检——无回退是 Task 2 的铁律，球绝不替用户挑会话）
//   ∧ 聚焦会话 AI 面板未开（request == null——面板头是入口，不摆第二颗球）
//   ∧ 无弹窗（modalStore.active == null）∧ 未锁定 ∧ vault 初始化就绪
//   ∧ 无 Otty 时刻在场（ottyStore.current == null）∧ 无 toast 在场
//     （toastStore.toasts 空）——plan「与 Toast、Otty 装饰动画避让」裁定 =
//     同一卸载路径让位（z150 覆盖层在场时不摆功能性控件；两者都是瞬态，
//     清场即自动回归，不做安全区数学）。
//
// 【拖拽】Pointer Events + setPointerCapture + window 级跟踪（捕获被夺仍能收
// 尾）；位移 <6px 视为点击（打开），≥6px 进拖拽态（实时吸附最近边），抬起
// 持久化边+分数并**吞掉紧随的 click**；pointercancel / lostpointercapture 一律
// 取消（不打开不持久化）。位置 = 边 + 分数（本机 localStorage，见 orbStore），
// 渲染时按 app-shell 矩形换算像素并钳制——窗口 resize 后分数天然比例适配，
// 极小视口由 orbPointFor 的终钳兜底；底部保留 ORB_BOTTOM_RESERVE 给终端输入
// 区，贴底不压输入行。
//
// 【静态铁律】闲置球零动画（无漂浮/呼吸）；hover/按压仅 --dur-fast 过渡。
// 琥珀问号徽标是品牌允许的点缀（Otty 在场必有 Amber），纯装饰 aria-hidden。
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useModalStore } from "../ui/modalStore";
import { useOttyStore } from "../ui/otty/ottyStore";
import { useToastStore } from "../ui/toastStore";
import { useVaultLockStore } from "../security/VaultLockStore";
import { useVaultInitGate } from "../security/VaultInitGate";
import { useSessionStore } from "../session/SessionStore";
import { captureAiTarget, isAiTargetLive, resolveFocusedTerminal } from "../session/aiTarget";
import { useAiStore } from "./aiStore";
import { ORB_DEFAULT_POSITION, useOrbStore, type OrbEdge, type OrbPosition } from "./orbStore";
import { OttyMark } from "../ui/otty/OttyMark";

/** 球直径（44px 命中面）与 32px 微缩 mark（32-ask-orb.css 同值，改两处同步）。 */
export const ORB_SIZE = 44;
/** 距 app-shell 可拖拽域边缘的保持距。 */
export const ORB_MARGIN = 8;
/** 底部安全垫：贴底/贴侧时给终端输入行留出的空间（拖拽时按 app-shell 实测
 * 矩形参与钳制；极小视口挤不下时由终钳保证球仍在域内）。 */
export const ORB_BOTTOM_RESERVE = 48;
/** 拖拽激活阈值（px）：小于它 = 手抖，视为点击。 */
export const ORB_DRAG_THRESHOLD = 6;

/** app-shell 可拖拽域矩形。 */
export interface OrbRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** app-shell 实测矩形（jsdom/无布局兜底 window 尺寸）。 */
function measureShell(): OrbRect {
  const el = document.querySelector(".app-shell");
  const r = el?.getBoundingClientRect();
  if (!r || (r.width === 0 && r.height === 0)) {
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** 位置 → 球左上角像素（含终钳：极小视口下 reserve 挤不进也不出界）。 */
export function orbPointFor(pos: OrbPosition, rect: OrbRect): { x: number; y: number } {
  const runX = Math.max(0, rect.width - ORB_SIZE - ORB_MARGIN * 2);
  const runY = Math.max(0, rect.height - ORB_SIZE - ORB_MARGIN * 2 - ORB_BOTTOM_RESERVE);
  const f = clamp01(pos.fraction);
  let x: number;
  let y: number;
  switch (pos.edge) {
    case "left":
      x = rect.left + ORB_MARGIN;
      y = rect.top + ORB_MARGIN + f * runY;
      break;
    case "right":
      x = rect.left + rect.width - ORB_SIZE - ORB_MARGIN;
      y = rect.top + ORB_MARGIN + f * runY;
      break;
    case "top":
      x = rect.left + ORB_MARGIN + f * runX;
      y = rect.top + ORB_MARGIN;
      break;
    case "bottom":
      x = rect.left + ORB_MARGIN + f * runX;
      y = rect.top + rect.height - ORB_SIZE - ORB_MARGIN - ORB_BOTTOM_RESERVE;
      break;
  }
  return {
    x: clamp(x, rect.left + ORB_MARGIN, rect.left + rect.width - ORB_MARGIN - ORB_SIZE),
    y: clamp(y, rect.top + ORB_MARGIN, rect.top + rect.height - ORB_MARGIN - ORB_SIZE),
  };
}

/** 球左上角 → 最近边吸附位置（边缘锚定的唯一归一口径）。 */
export function snapToEdge(px: number, py: number, rect: OrbRect): OrbPosition {
  const cx = px + ORB_SIZE / 2;
  const cy = py + ORB_SIZE / 2;
  const dist: Record<OrbEdge, number> = {
    left: cx - rect.left,
    right: rect.left + rect.width - cx,
    top: cy - rect.top,
    bottom: rect.top + rect.height - cy,
  };
  let edge: OrbEdge = "left";
  for (const e of ["right", "top", "bottom"] as const) {
    if (dist[e] < dist[edge]) edge = e;
  }
  const runX = Math.max(0, rect.width - ORB_SIZE - ORB_MARGIN * 2);
  const runY = Math.max(0, rect.height - ORB_SIZE - ORB_MARGIN * 2 - ORB_BOTTOM_RESERVE);
  const fraction =
    edge === "left" || edge === "right"
      ? clamp01((cy - rect.top - ORB_MARGIN) / (runY || 1))
      : clamp01((cx - rect.left - ORB_MARGIN) / (runX || 1));
  return { edge, fraction };
}

interface Gesture {
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  rect: OrbRect;
}

export function AskOttrOrb({ onAsk }: { onAsk: () => void }) {
  const { t } = useTranslation();
  // --- 可见性门（各 store 独立订阅；App 同款读法） ---
  const mainView = useWorkspaceStore((s) => s.mainView);
  const orbEnabled = useOrbStore((s) => s.enabled);
  const orbPosition = useOrbStore((s) => s.position);
  const activeModal = useModalStore((s) => s.active);
  const lockPhase = useVaultLockStore((s) => s.phase);
  const initPhase = useVaultInitGate((s) => s.phase);
  const focused = useSessionStore((s) => resolveFocusedTerminal(s));
  const target = useMemo(() => (focused ? captureAiTarget(focused) : null), [focused]);
  const targetLive = useSessionStore((s) => (target ? isAiTargetLive(target, s) : false));
  const panelOpen = useAiStore((s) =>
    focused != null ? s.sessions[focused.id]?.request != null : false,
  );
  // 避让门（plan Task 4「与 Toast、Otty 装饰动画避让」，控制器裁定 = 让位卸载）：
  // 两者都是 z150 覆盖层，在场即让（瞬态——清场自动回归，不做安全区数学）。
  const ottyMomentActive = useOttyStore((s) => s.current !== null);
  const toastVisible = useToastStore((s) => s.toasts.length > 0);

  // --- 拖拽状态 ---
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<OrbPosition | null>(null);
  const draggingRef = useRef(false);
  const dragPosRef = useRef<OrbPosition | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const suppressedRef = useRef(false);
  // resize 触发重渲染（位置按矩形重算——fraction 天然比例适配）
  const [, bump] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
  }, [bump]);

  // window 级跟踪（捕获被夺/指针滑出按钮仍收尾；jsdom 经冒泡同样命中）。
  // 四个处理器必须恒为同一实例（useCallback []）：pointerdown 挂上的监听与
  // cleanupGesture 摘除的是同一组引用，重渲染不产生悬挂监听。它们只读 ref 与
  // React 稳定 setter，闭包不持过期状态。
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 引用同级 useCallback 常量，见上
  const cleanupGesture = useCallback(() => {
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("pointerup", onWindowUp);
    window.removeEventListener("pointercancel", onWindowCancel);
    window.removeEventListener("lostpointercapture", onWindowCancel);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onWindowMove = useCallback((e: PointerEvent): void => {
    const g = gestureRef.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!draggingRef.current) {
      if (Math.hypot(dx, dy) < ORB_DRAG_THRESHOLD) return;
      draggingRef.current = true;
      setDragging(true);
    }
    const nx = clamp(
      g.baseX + dx,
      g.rect.left + ORB_MARGIN,
      g.rect.left + g.rect.width - ORB_MARGIN - ORB_SIZE,
    );
    const ny = clamp(
      g.baseY + dy,
      g.rect.top + ORB_MARGIN,
      g.rect.top + g.rect.height - ORB_MARGIN - ORB_SIZE,
    );
    const next = snapToEdge(nx, ny, g.rect);
    dragPosRef.current = next;
    setDragPos(next);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onWindowUp = useCallback((_e: PointerEvent): void => {
    const g = gestureRef.current;
    cleanupGesture();
    gestureRef.current = null;
    if (!g) return;
    if (draggingRef.current) {
      draggingRef.current = false;
      setDragging(false);
      // 拖过的抬起：落库 + 吞掉真浏览器紧随的 click（不开面板）
      suppressedRef.current = true;
      const final = dragPosRef.current;
      dragPosRef.current = null;
      setDragPos(null);
      if (final) useOrbStore.getState().setPosition(final);
    }
  }, [cleanupGesture]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onWindowCancel = useCallback((): void => {
    if (!gestureRef.current && !draggingRef.current) return; // 正常抬起后的 lostcapture 尾音
    cleanupGesture();
    gestureRef.current = null;
    draggingRef.current = false;
    setDragging(false);
    dragPosRef.current = null;
    setDragPos(null);
    suppressedRef.current = true; // 取消 ≠ 点击
  }, [cleanupGesture]);

  // 手势监听随卸载收尾（拖拽中途弹窗顶掉球等场景不留全局监听）
  useEffect(() => cleanupGesture, [cleanupGesture]);

  if (
    mainView !== "terminal" ||
    orbEnabled !== true ||
    !target ||
    !targetLive ||
    panelOpen ||
    activeModal !== null ||
    lockPhase === "locked" ||
    initPhase !== "ready" ||
    ottyMomentActive ||
    toastVisible
  ) {
    return null; // 隐藏即卸载：不留可聚焦的幽灵按钮
  }

  const pos = dragPos ?? orbPosition ?? ORB_DEFAULT_POSITION;
  const { x, y } = orbPointFor(pos, measureShell());
  const label = t("ai.orbLabel");

  return (
    <button
      type="button"
      className={dragging ? "ask-orb dragging" : "ask-orb"}
      data-testid="ask-ottr-orb"
      style={{ left: x, top: y }}
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const rect = measureShell();
        const base = orbPointFor(dragPos ?? orbPosition ?? ORB_DEFAULT_POSITION, rect);
        gestureRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          baseX: base.x,
          baseY: base.y,
          rect,
        };
        suppressedRef.current = false; // 新手势重置吞咽旗标（键盘点击不受上次取消拖累）
        // 捕获 + window 双保险：真内核指针滑出仍归球管；jsdom 走冒泡路径。
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // 捕获不可用（旧内核）：window 监听已覆盖
        }
        window.addEventListener("pointermove", onWindowMove);
        window.addEventListener("pointerup", onWindowUp);
        window.addEventListener("pointercancel", onWindowCancel);
        window.addEventListener("lostpointercapture", onWindowCancel);
      }}
      onClick={() => {
        if (suppressedRef.current) {
          suppressedRef.current = false;
          return; // 拖拽/取消后的 click 一律吞咽
        }
        onAsk();
      }}
      onKeyDown={(e) => {
        // 键盘激活不受上一手势吞咽旗标拖累
        if (e.key === "Enter" || e.key === " ") suppressedRef.current = false;
      }}
    >
      <OttyMark size={32} />
      <span className="ask-orb-badge" aria-hidden="true">
        ?
      </span>
    </button>
  );
}
