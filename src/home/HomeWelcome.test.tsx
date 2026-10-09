// HomeWelcome 组件测试（2026-10-10 壳层重构）：时段问候（注入 now）、快捷卡
// 动作、最近连接（localStorage 标签持久化顺序）与条件夹具入口。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Host } from "../vault/api";

// 词典断言用中文：在 import 前钉住 navigator.language（i18n 实例按它初始化，
// 同 SecuritySettings.test 口径）。
vi.hoisted(() => {
  Object.defineProperty(window.navigator, "language", {
    value: "zh-CN",
    configurable: true,
  });
});

import "./../i18n";
import { HomeWelcome, greetingKey } from "./HomeWelcome";

function makeHost(overrides: Partial<Host>): Host {
  return {
    id: 1,
    name: "web-01",
    group_id: null,
    tags: [],
    address: "10.0.0.1",
    port: 22,
    username: null,
    protocol: "ssh",
    credential_id: null,
    jump_chain_id: null,
    encoding_override: null,
    theme_override: null,
    monitor_enabled: false,
    is_production: false,
    notes: null,
    ...overrides,
  };
}

const noop = () => {};

function renderHome(overrides?: Partial<Parameters<typeof HomeWelcome>[0]>) {
  const props: Parameters<typeof HomeWelcome>[0] = {
    hosts: [],
    fixtureHost: null,
    onAddHost: vi.fn(),
    onOpenPalette: vi.fn(),
    onOpenImport: vi.fn(),
    onConnect: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<HomeWelcome {...props} />) };
}

afterEach(() => {
  cleanup();
  localStorage.removeItem("ottr.session.openHostIds");
});

describe("greetingKey（时段问候纯函数）", () => {
  it("5-12 早 / 12-18 午 / 其余晚", () => {
    expect(greetingKey(6)).toBe("morning");
    expect(greetingKey(12)).toBe("afternoon");
    expect(greetingKey(23)).toBe("evening");
    expect(greetingKey(3)).toBe("evening");
  });
});

describe("HomeWelcome", () => {
  it("时段问候：注入上午时间显示早上好（中文词典钉）", () => {
    renderHome({ now: new Date(2026, 9, 9, 9, 0) });
    expect(screen.getByTestId("home-greeting").textContent).toBe("早上好");
  });

  it("快捷卡：新建主机/快速连接/导入配置动作各自触发", () => {
    const { props } = renderHome();
    fireEvent.click(screen.getByTestId("empty-add-host"));
    expect(props.onAddHost).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("empty-palette-hint"));
    expect(props.onOpenPalette).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("empty-import"));
    expect(props.onOpenImport).toHaveBeenCalledTimes(1);
  });

  it("入口缺省裁剪：不给回调则对应卡不渲染", () => {
    renderHome({ onAddHost: undefined, onOpenPalette: undefined, onOpenImport: undefined });
    expect(screen.queryByTestId("empty-add-host")).toBeNull();
    expect(screen.queryByTestId("empty-palette-hint")).toBeNull();
    expect(screen.queryByTestId("empty-import")).toBeNull();
  });

  it("最近连接：标签持久化顺序渲染前 5，点击 onConnect", () => {
    const hosts = [
      makeHost({ id: 7, name: "nas", address: "192.168.1.7" }),
      makeHost({ id: 3, name: "web-01", address: "10.0.0.1" }),
    ];
    localStorage.setItem("ottr.session.openHostIds", JSON.stringify([3, 7, 999]));
    const onConnect = vi.fn();
    renderHome({ hosts, onConnect });
    expect(screen.getByTestId("home-recent")).toBeTruthy();
    fireEvent.click(screen.getByTestId("home-recent-3"));
    expect(onConnect).toHaveBeenCalledWith(hosts[1]);
  });

  it("无打开标签记录：最近连接区块不渲染", () => {
    renderHome({});
    expect(screen.queryByTestId("home-recent")).toBeNull();
  });
});
