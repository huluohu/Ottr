// AskOttrOrb 组件测试（Ask Ottr Task 4）：可见性门（主区视图 / 开关 / 活目标 /
// 面板未开 / 无弹窗 / 未锁定 / 初始化就绪——逐门独立验证）、点击与键盘开启、
// 拖拽（≥6px 阈值、点击吞咽、持久化、pointercancel/lostpointercapture 取消、
// 微小视口钳制、resize 重钳制）。store 全用真实例 setState 播种（IconRail
// 测试同口径）；jsdom 无 getBoundingClientRect/指针捕获 API——本文件内最小
// 打桩（见各 beforeEach 注释）。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import "../i18n";
import { AskOttrOrb, ORB_BOTTOM_RESERVE, ORB_MARGIN, ORB_SIZE } from "./AskOttrOrb";
import { ORB_POSITION_KEY, useOrbStore } from "./orbStore";
import { useAiStore } from "./aiStore";
import { useModalStore } from "../ui/modalStore";
import { useVaultLockStore } from "../security/VaultLockStore";
import { useVaultInitGate } from "../security/VaultInitGate";
import { useSessionStore } from "../session/SessionStore";
import { useWorkspaceStore } from "../workspace/workspaceStore";
import { useOttyStore } from "../ui/otty/ottyStore";
import { useToastStore } from "../ui/toastStore";
import type { Session } from "../session/types";

/** 会话夹具（aiTarget.test 同构）：默认 = hostA 已连接 SSH 根会话。 */
function sess(over: Partial<Session> & Pick<Session, "id">): Session {
  return {
    hostId: 1,
    hostName: "web-01",
    address: "10.0.0.1",
    port: 22,
    username: "deploy",
    protocol: "ssh",
    jumpChainId: null,
    status: "connected",
    rustId: "pty-a",
    attempt: 0,
    lastError: null,
    nextRetryAt: null,
    paneOf: null,
    encoding: "utf-8",
    encodingOverride: "utf-8",
    encodingHint: null,
    isProduction: false,
    connectionEpoch: 1,
    ...over,
  };
}

/** app-shell 几何（可变桩）：指针几何与钳制断言都读它。 */
const shellRect = { left: 0, top: 0, width: 800, height: 600 };

let origGBCR: typeof Element.prototype.getBoundingClientRect | null = null;

beforeEach(() => {
  origGBCR = Element.prototype.getBoundingClientRect;
  // jsdom 无布局：对 .app-shell 回固定矩形，其余元素保持原行为（全零）
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    if (this.classList.contains("app-shell")) {
      return {
        x: shellRect.left,
        y: shellRect.top,
        top: shellRect.top,
        left: shellRect.left,
        right: shellRect.left + shellRect.width,
        bottom: shellRect.top + shellRect.height,
        width: shellRect.width,
        height: shellRect.height,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return origGBCR!.call(this);
  });
  // jsdom 未实现 Element 指针捕获（组件内 ?. 可选调用，桩掉仅为收集调用面）
  if (typeof (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture !== "function") {
    (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture = vi.fn();
  }
  if (
    typeof (Element.prototype as { releasePointerCapture?: unknown }).releasePointerCapture !==
    "function"
  ) {
    (Element.prototype as { releasePointerCapture?: unknown }).releasePointerCapture = vi.fn();
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.querySelectorAll<HTMLElement>(".app-shell").forEach((el) => el.remove());
});

/** 全门通过的种子：终端视图 + 开关开 + 已连接聚焦 pane + 面板关 + 无弹窗 +
 * 未锁定 + 初始化就绪。各门用例在此基础上只翻自己那扇门。 */
function seedAllGatesOpen(over?: {
  sessions?: Session[];
  activeId?: string | null;
  activePane?: Record<string, string>;
}) {
  useWorkspaceStore.setState({ mainView: "terminal", overviewOpen: false });
  useOrbStore.setState({ enabled: true, position: null });
  useModalStore.setState({ active: null });
  useVaultLockStore.setState({ phase: "unlocked", mode: "password" });
  useVaultInitGate.setState({ phase: "ready", error: null });
  useAiStore.setState({ sessions: {} });
  useOttyStore.setState({ current: null, queue: [], enabled: true }); // 避让门：清场
  useToastStore.setState({ toasts: [] }); // 避让门：清场
  useSessionStore.setState({
    sessions: over?.sessions ?? [sess({ id: "tab-a" })],
    activeId: over?.activeId ?? "tab-a",
    activePane: over?.activePane ?? { "tab-a": "tab-a" },
  });
}

function renderOrb(onAsk: () => void = vi.fn()) {
  // 球的几何以 .app-shell 矩形为界——渲染进 app-shell 宿主（jsdom 无布局，
  // 矩形来自上面的打桩）
  const host = document.createElement("div");
  host.className = "app-shell";
  document.body.appendChild(host);
  const utils = render(<AskOttrOrb onAsk={onAsk} />, { container: host });
  return { onAsk, ...utils };
}

describe("AskOttrOrb（可见性门——隐藏即卸载，不可聚焦）", () => {
  it("全门通过：渲染球（aria-label/title 来自 ai.orbLabel，原生 button 键盘可达）", () => {
    seedAllGatesOpen();
    renderOrb();
    const btn = screen.getByTestId("ask-ottr-orb");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    const label = btn.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toBe(btn.getAttribute("title"));
    expect(btn.getAttribute("aria-keyshortcuts")).toBeNull();
  });

  it("mainView 门：离开终端视图（总览）即隐藏", () => {
    seedAllGatesOpen();
    useWorkspaceStore.setState({ mainView: "overview" });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
  });

  it("开关门：enabled=false 与未加载 null 都隐藏（null 防真源闪烁）", () => {
    seedAllGatesOpen();
    useOrbStore.setState({ enabled: false });
    const { container } = renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
    cleanup();
    useOrbStore.setState({ enabled: null });
    render(<AskOttrOrb onAsk={vi.fn()} />, { container: container.parentElement as HTMLElement });
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
  });

  it("活目标门：聚焦 pane 未连接（无 rustId）不渲染——不回退到其他已连接会话", () => {
    seedAllGatesOpen({
      sessions: [sess({ id: "tab-a", status: "disconnected", rustId: null }), sess({ id: "tab-b" })],
      activeId: "tab-a",
      activePane: { "tab-a": "tab-a", "tab-b": "tab-b" },
    });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
  });

  it("活目标门：聚焦 pane 指向已移除的 pane（无回退漂移）不渲染", () => {
    seedAllGatesOpen({
      sessions: [sess({ id: "tab-a" })],
      activeId: "tab-a",
      activePane: { "tab-a": "pane-gone" },
    });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
  });

  it("活目标门：ftp 纯文件会话（无 PTY）不渲染", () => {
    seedAllGatesOpen({
      sessions: [
        sess({ id: "tab-f", protocol: "ftp", status: "connected", rustId: "ftp-1" }),
      ],
      activeId: "tab-f",
      activePane: { "tab-f": "tab-f" },
    });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
  });

  it("面板门：聚焦会话已开 AI 面板（request 非空）隐藏——面板头是入口，不摆第二颗球", () => {
    seedAllGatesOpen();
    useAiStore.setState({
      sessions: { "tab-a": { request: { kind: "ask", sessionId: "tab-a" } } as never },
    });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
  });

  it("弹窗门：任一弹窗占槽（settings）即隐藏", () => {
    seedAllGatesOpen();
    useModalStore.setState({ active: "settings" });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
  });

  it("锁定门：锁屏 phase=locked 隐藏（卸载，非透明遮盖）", () => {
    seedAllGatesOpen();
    useVaultLockStore.setState({ phase: "locked" });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
  });

  it("初始化门：vault 初始化未就绪（initializing）隐藏", () => {
    seedAllGatesOpen();
    useVaultInitGate.setState({ phase: "initializing" });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
  });

  it("避让门：Otty 情感时刻在场（current 非空）即卸载；清场自动回归（瞬态让位）", () => {
    seedAllGatesOpen();
    useOttyStore.setState({ current: "connect", queue: [] });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
    act(() => {
      useOttyStore.setState({ current: null }); // 时刻播完
    });
    expect(screen.getByTestId("ask-ottr-orb")).toBeTruthy();
  });

  it("避让门：toast 在场即卸载；清空自动回归（瞬态让位）", () => {
    seedAllGatesOpen();
    useToastStore.setState({
      toasts: [{ id: 1, message: "CSV 已导出", kind: "info" }],
    });
    renderOrb();
    expect(screen.queryByTestId("ask-ottr-orb")).toBeNull();
    act(() => {
      useToastStore.setState({ toasts: [] }); // toast 到期/手关
    });
    expect(screen.getByTestId("ask-ottr-orb")).toBeTruthy();
  });
});

describe("AskOttrOrb（开启动作）", () => {
  it("点击：onAsk 恰调一次（App 侧统一走 handleAction(\"ai.ask\")）", () => {
    seedAllGatesOpen();
    const onAsk = vi.fn();
    renderOrb(onAsk);
    fireEvent.click(screen.getByTestId("ask-ottr-orb"));
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("键盘可达：原生 button（Enter/Space 激活语义）；jsdom 不合成按键 click，用激活行为等价驱动", () => {
    seedAllGatesOpen();
    const onAsk = vi.fn();
    renderOrb(onAsk);
    const btn = screen.getByTestId("ask-ottr-orb");
    // jsdom 不实现 button 的 Enter/Space → click 合成（已知缺口）；键盘激活
    // 的产物就是一次 click，这里直接驱动同一激活行为断言同一代码路径。
    (btn as HTMLButtonElement).click();
    expect(onAsk).toHaveBeenCalledTimes(1);
  });
});

describe("AskOttrOrb（拖拽 vs 点击）", () => {
  it("拖拽 ≥6px：换位 + 不触发 onAsk + 位置持久化 localStorage（最近边吸附）", () => {
    seedAllGatesOpen();
    const onAsk = vi.fn();
    renderOrb(onAsk);
    const btn = screen.getByTestId("ask-ottr-orb");
    // 默认位 right/0.5 → 起点 (748, 254)（800x600 几何）
    fireEvent.pointerDown(btn, { pointerId: 1, button: 0, clientX: 748, clientY: 254 });
    fireEvent.pointerMove(btn, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(btn.className).toContain("dragging"); // 拖拽态 class（cursor/scale）
    fireEvent.pointerUp(btn, { pointerId: 1, clientX: 100, clientY: 100 });
    // 拖过的抬起必须吞掉 click（真浏览器 pointerup 后原生跟发 click）
    fireEvent.click(btn);
    expect(onAsk).not.toHaveBeenCalled();
    const stored = JSON.parse(localStorage.getItem(ORB_POSITION_KEY) ?? "null") as {
      edge: string;
      fraction: number;
    } | null;
    expect(stored).not.toBeNull();
    expect(stored!.edge).toBe("left"); // (108,54) 的球心离左缘最近
    expect(stored!.fraction).toBeGreaterThanOrEqual(0);
    expect(stored!.fraction).toBeLessThanOrEqual(1);
    expect(useOrbStore.getState().position).toEqual(stored);
    // 拖拽态随抬起解除
    expect(btn.className).not.toContain("dragging");
  });

  it("位移 <6px：视为点击（不进拖拽态、不写存档），click 正常开启", () => {
    seedAllGatesOpen();
    const onAsk = vi.fn();
    renderOrb(onAsk);
    const btn = screen.getByTestId("ask-ottr-orb");
    fireEvent.pointerDown(btn, { pointerId: 1, button: 0, clientX: 748, clientY: 254 });
    fireEvent.pointerMove(btn, { pointerId: 1, clientX: 751, clientY: 256 });
    expect(btn.className).not.toContain("dragging");
    fireEvent.pointerUp(btn, { pointerId: 1, clientX: 751, clientY: 256 });
    fireEvent.click(btn);
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ORB_POSITION_KEY)).toBeNull();
  });

  it("pointercancel：取消不打开、不持久化、退出拖拽态", () => {
    seedAllGatesOpen();
    const onAsk = vi.fn();
    renderOrb(onAsk);
    const btn = screen.getByTestId("ask-ottr-orb");
    fireEvent.pointerDown(btn, { pointerId: 1, button: 0, clientX: 748, clientY: 254 });
    fireEvent.pointerMove(btn, { pointerId: 1, clientX: 120, clientY: 120 });
    expect(btn.className).toContain("dragging");
    fireEvent.pointerCancel(btn, { pointerId: 1 });
    expect(btn.className).not.toContain("dragging");
    // 某些内核取消后仍补发 click——必须吞咽
    fireEvent.click(btn);
    expect(onAsk).not.toHaveBeenCalled();
    expect(localStorage.getItem(ORB_POSITION_KEY)).toBeNull();
    expect(useOrbStore.getState().position).toBeNull();
  });

  it("lostpointercapture：捕获被夺即取消（不打开、不持久化）", () => {
    seedAllGatesOpen();
    const onAsk = vi.fn();
    renderOrb(onAsk);
    const btn = screen.getByTestId("ask-ottr-orb");
    fireEvent.pointerDown(btn, { pointerId: 1, button: 0, clientX: 748, clientY: 254 });
    fireEvent.pointerMove(btn, { pointerId: 1, clientX: 130, clientY: 130 });
    fireEvent.lostPointerCapture(btn, { pointerId: 1 });
    fireEvent.click(btn);
    expect(onAsk).not.toHaveBeenCalled();
    expect(localStorage.getItem(ORB_POSITION_KEY)).toBeNull();
  });
});

describe("AskOttrOrb（几何钳制）", () => {
  it("微小视口：贴边位不越界（底部保留区挤不进时退到界内）", () => {
    seedAllGatesOpen();
    shellRect.width = 120;
    shellRect.height = 90;
    useOrbStore.setState({ position: { edge: "bottom", fraction: 1 } });
    renderOrb();
    const btn = screen.getByTestId("ask-ottr-orb") as HTMLElement;
    const x = parseFloat(btn.style.left);
    const y = parseFloat(btn.style.top);
    expect(x).toBeGreaterThanOrEqual(shellRect.left + ORB_MARGIN);
    expect(x + ORB_SIZE).toBeLessThanOrEqual(shellRect.left + shellRect.width);
    expect(y).toBeGreaterThanOrEqual(shellRect.top + ORB_MARGIN);
    expect(y + ORB_SIZE).toBeLessThanOrEqual(shellRect.top + shellRect.height);
  });

  it("终端输入行保留区：常规视口贴底时球悬在输入区之上（reserve 参与下界）", () => {
    seedAllGatesOpen();
    shellRect.width = 800;
    shellRect.height = 600;
    useOrbStore.setState({ position: { edge: "bottom", fraction: 0.5 } });
    renderOrb();
    const btn = screen.getByTestId("ask-ottr-orb") as HTMLElement;
    const y = parseFloat(btn.style.top);
    expect(y).toBeCloseTo(600 - ORB_SIZE - ORB_MARGIN - ORB_BOTTOM_RESERVE, 0);
    // 侧缘吸附同理避开底部保留区（fraction=0 贴顶、=1 贴保留区上沿）
    useOrbStore.setState({ position: { edge: "left", fraction: 1 } });
    const y2 = parseFloat(btn.style.top);
    expect(y2 + ORB_SIZE).toBeLessThanOrEqual(600 - ORB_BOTTOM_RESERVE + ORB_MARGIN);
  });

  it("resize：视口变小后位置即时重钳制（fraction 制天然比例适配）", () => {
    seedAllGatesOpen();
    useOrbStore.setState({ position: { edge: "right", fraction: 1 } });
    renderOrb();
    const btn = screen.getByTestId("ask-ottr-orb") as HTMLElement;
    const before = parseFloat(btn.style.top);
    shellRect.height = 300;
    fireEvent(window, new Event("resize"));
    const after = parseFloat(btn.style.top);
    expect(after).toBeLessThan(before);
    expect(after + ORB_SIZE).toBeLessThanOrEqual(300);
  });
});
