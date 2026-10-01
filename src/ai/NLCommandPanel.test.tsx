// NLCommandPanel 组件测试（Phase 2 B1，Task 6）：
//   * 底部输入条渲染面：输入/生成按钮使能、流式原文、thinking、aborted；
//   * done → 公共 InsertRow 渲染：danger 徽标 + 三档确认插终端（green 一击 /
//     red 两击），插入目标 = 聚焦 pane 的 rustId，无连接禁用；
//   * 错误面：noProvider → 去设置 / request → 重试 / empty → 说明 + 重试；
//   * 键盘：Enter 生成、Esc 关闭。
// 运行链（nlStore）在 nl2cmd.test.ts 已全覆盖，本文件用 store 播种驱动渲染面，
// 另带一条 live 流（Mock provider）验证 input → submit → 结果渲染的接线。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("./provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./provider")>();
  return {
    ...orig,
    createProvider: () => orig.createMockProvider(["docker ps"]),
  };
});

import i18n from "../i18n";
import { NLCommandPanel } from "./NLCommandPanel";
import { useNlStore } from "./nl2cmd";
import { useSessionStore, type Session } from "../session/SessionStore";

const mockedInvoke = invoke as unknown as Mock;

/** 原生动作引用（键盘用例以 spy 顶替 submit，beforeEach 必须还原）。 */
const realSubmit = useNlStore.getState().submit;

function backendWithProvider() {
  mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
    if (cmd === "settings_get" && args?.key === "ai_providers") {
      return Promise.resolve([
        {
          id: "p1",
          name: "DeepSeek",
          kind: "openai-compatible",
          baseURL: "https://api.deepseek.com",
          model: "deepseek-chat",
        },
      ]);
    }
    if (cmd === "secret_get") return Promise.resolve("sk-test");
    return Promise.resolve(null);
  });
}

const SESSION: Session = {
  id: "tab-1",
  hostId: 7,
  hostName: "web-01",
  address: "10.1.2.3",
  port: 22,
  username: "ops",
  protocol: "ssh",
  status: "connected",
  rustId: "pty-9",
  attempt: 0,
  lastError: null,
  nextRetryAt: null,
  paneOf: null,
  encoding: "utf-8",
  encodingOverride: "utf-8",
  encodingHint: null,
};

function seedSession(present: boolean) {
  useSessionStore.setState({
    sessions: present ? [SESSION] : [],
    activeId: present ? "tab-1" : null,
    activePane: {},
    trees: {},
  });
}

beforeEach(async () => {
  mockedInvoke.mockReset();
  useNlStore.setState({ submit: realSubmit }); // 还原被 spy 顶替的动作
  useNlStore.getState().close();
  seedSession(true);
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => cleanup());

function renderPanel(over: Partial<Parameters<typeof NLCommandPanel>[0]> = {}) {
  return render(
    <NLCommandPanel
      open={true}
      onClose={over.onClose ?? (() => {})}
      onOpenSettings={over.onOpenSettings ?? (() => {})}
      inserter={over.inserter}
    />,
  );
}

describe("输入条渲染面", () => {
  it("open=false 不渲染", () => {
    const { container } = render(
      <NLCommandPanel open={false} onClose={() => {}} onOpenSettings={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("空输入：生成按钮禁用；输入后使能", () => {
    renderPanel();
    const run = screen.getByTestId("nl2cmd-run") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("nl2cmd-input"), { target: { value: "列出容器" } });
    expect(run.disabled).toBe(false);
  });

  it("running：流式原文等宽呈现 + 停止按钮；空答案显示思考中", () => {
    useNlStore.setState({ status: "running", answer: "" });
    const first = renderPanel();
    expect(screen.getByTestId("nl2cmd-thinking").textContent).toContain("生成中");
    expect(screen.getByTestId("nl2cmd-stop")).toBeTruthy();
    first.unmount();
    useNlStore.setState({ status: "running", answer: "docker ps -a" });
    renderPanel();
    expect(screen.getByTestId("nl2cmd-stream").textContent).toBe("docker ps -a");
    expect(screen.queryByTestId("nl2cmd-run")).toBeNull();
  });

  it("aborted：已取消", () => {
    useNlStore.setState({ status: "aborted" });
    renderPanel();
    expect(screen.getByTestId("nl2cmd-aborted").textContent).toContain("已取消");
  });
});

describe("结果面（公共 InsertRow 三档确认）", () => {
  it("done green：安全徽标 + 一击直插聚焦 pane（write_session 同路）", async () => {
    useNlStore.setState({ status: "done", command: "docker ps", level: "green" });
    const inserter = vi.fn().mockResolvedValue(undefined);
    renderPanel({ inserter });
    expect(screen.getByTestId("ai-code-level").textContent).toBe("安全");
    fireEvent.click(screen.getByTestId("ai-insert"));
    await vi.waitFor(() => {
      expect(inserter).toHaveBeenCalledWith("pty-9", "docker ps");
    });
  });

  it("done red：危险徽标 + 两击确认（armed → 插入）", async () => {
    useNlStore.setState({ status: "done", command: "rm -rf /tmp/build", level: "red" });
    const inserter = vi.fn().mockResolvedValue(undefined);
    renderPanel({ inserter });
    expect(screen.getByTestId("ai-code-level").textContent).toBe("危险");
    const btn = screen.getByTestId("ai-insert");
    fireEvent.click(btn);
    expect(inserter).not.toHaveBeenCalled();
    expect(btn.getAttribute("data-stage")).toBe("armed");
    fireEvent.click(btn);
    await vi.waitFor(() => {
      expect(inserter).toHaveBeenCalledWith("pty-9", "rm -rf /tmp/build");
    });
  });

  it("无连接终端（聚焦 pane 无 rustId）：插入按钮禁用", () => {
    useNlStore.setState({ status: "done", command: "docker ps", level: "green" });
    seedSession(false);
    renderPanel({ inserter: vi.fn().mockResolvedValue(undefined) });
    expect((screen.getByTestId("ai-insert") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("错误面", () => {
  it("request：端点消息 + 重试（原输入再发）", () => {
    useNlStore.setState({ status: "error", errorKind: "request", error: "HTTP 401: bad key" });
    const submitSpy = vi.fn();
    useNlStore.setState({ submit: submitSpy });
    renderPanel();
    expect(screen.getByTestId("nl2cmd-error-message").textContent).toContain("HTTP 401");
    fireEvent.click(screen.getByTestId("nl2cmd-retry"));
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("empty：无可用命令说明 + 重试", () => {
    useNlStore.setState({ status: "error", errorKind: "empty", error: null });
    const submitSpy = vi.fn();
    useNlStore.setState({ submit: submitSpy });
    renderPanel();
    expect(screen.getByTestId("nl2cmd-empty-message").textContent).toContain("没有返回可用");
    fireEvent.click(screen.getByTestId("nl2cmd-retry"));
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("noProvider：去设置按钮回调", () => {
    useNlStore.setState({ status: "error", errorKind: "noProvider", error: null });
    const onOpenSettings = vi.fn();
    renderPanel({ onOpenSettings });
    fireEvent.click(screen.getByTestId("nl2cmd-open-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe("键盘", () => {
  it("Esc 关闭（清场 + 上抛）", () => {
    useNlStore.setState({ input: "ls", status: "idle" });
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.keyDown(screen.getByTestId("nl2cmd-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // 清场：input/status 复位
    const st = useNlStore.getState();
    expect(st.input).toBe("");
    expect(st.status).toBe("idle");
  });

  it("Enter 非空输入触发生成", () => {
    useNlStore.setState({ input: "列出容器", status: "idle" });
    const submitSpy = vi.fn();
    useNlStore.setState({ submit: submitSpy });
    renderPanel();
    fireEvent.keyDown(screen.getByTestId("nl2cmd-input"), { key: "Enter" });
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("live 流（input → submit → done 渲染）", () => {
  it("输入自然语言 → 生成 → 命令 + 安全徽标出现", async () => {
    backendWithProvider();
    renderPanel();
    fireEvent.change(screen.getByTestId("nl2cmd-input"), { target: { value: "列出运行中的容器" } });
    fireEvent.click(screen.getByTestId("nl2cmd-run"));
    await vi.waitFor(() => {
      expect(useNlStore.getState().status).toBe("done");
    });
    expect(screen.getByTestId("ai-code-text").textContent).toBe("docker ps");
    expect(screen.getByTestId("ai-code-level").textContent).toBe("安全");
    expect(screen.getByTestId("nl2cmd-run")).toBeTruthy(); // 回到输入态，可继续生成
  });
});
