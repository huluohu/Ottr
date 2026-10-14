// HostKeyDialog 渲染测试（Phase 2 Task 2 fix M-3）：跳板链逐跳问询的
// 「第 N 跳」标识（hop 0 起 → 展示 1 起）与直连问询（无 hop 字段）不渲染。
// store 直推 hostKeyAsk（弹窗纯渲染面，无 invoke）。2026-10-14 起弹窗归
// 全局唯一槽（ui/modalStore）：置问询须同时认领 "hostKey" 槽（SessionStore
// 真实路径同款），未持槽 = 不渲染即本机制的预期行为。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../i18n";
import i18n from "../i18n";
import { HostKeyDialog } from "./HostKeyDialog";
import { useSessionStore } from "./SessionStore";
import { useModalStore } from "../ui/modalStore";

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useSessionStore.setState({ hostKeyAsk: null });
  useModalStore.setState({ active: null });
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ hostKeyAsk: null });
  useModalStore.setState({ active: null });
  void i18n.changeLanguage("en-US");
});

describe("HostKeyDialog", () => {
  it("无问询不渲染", () => {
    render(<HostKeyDialog />);
    expect(screen.queryByTestId("host-key-dialog")).toBeNull();
  });

  it("链式问询（hop=0）→「第 1 跳」标识；指纹照常展示", () => {
    useSessionStore.setState({
      hostKeyAsk: {
        host_id: 1,
        host_name: "bastion-a",
        fingerprint: "SHA256:hop0",
        kind: "first",
        hop: 0,
        origin_host_id: 2,
        sessionId: "",
      },
    });
    useModalStore.getState().open("hostKey");
    render(<HostKeyDialog />);
    expect(screen.getByTestId("host-key-dialog")).toBeTruthy();
    expect(screen.getByTestId("host-key-hop").textContent).toBe("第 1 跳");
    expect(screen.getByTestId("host-key-fingerprint").textContent).toBe("SHA256:hop0");
  });

  it("直连问询（无 hop 字段）→ 不渲染跳标识（载荷形状向后兼容）", () => {
    useSessionStore.setState({
      hostKeyAsk: {
        host_id: 2,
        host_name: "db-01",
        fingerprint: "SHA256:direct",
        kind: "changed",
        sessionId: "tab-1",
      },
    });
    useModalStore.getState().open("hostKey");
    render(<HostKeyDialog />);
    expect(screen.getByTestId("host-key-dialog")).toBeTruthy();
    expect(screen.queryByTestId("host-key-hop")).toBeNull();
    expect(screen.getByTestId("host-key-fingerprint").textContent).toBe("SHA256:direct");
  });

  it("问询在而槽位被其他弹窗占用 → 不渲染（单实例裁定：未持槽即隐）", () => {
    useSessionStore.setState({
      hostKeyAsk: {
        host_id: 2,
        host_name: "db-01",
        fingerprint: "SHA256:direct",
        kind: "first",
        sessionId: "",
      },
    });
    useModalStore.getState().open("settings");
    render(<HostKeyDialog />);
    expect(screen.queryByTestId("host-key-dialog")).toBeNull();
  });
});
