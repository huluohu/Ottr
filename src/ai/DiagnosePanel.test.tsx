// DiagnosePanel 组件测试（T13）：流式渲染、代码块插终端三档确认状态机、
// 错误面（noProvider/noKey → 去设置）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import { useAiStore, type DiagnoseRequest } from "./aiStore";
import { DiagnosePanel, extractCodeBlocks } from "./DiagnosePanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => cleanup());
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN"); // 断言面向 zh 词典键
});

const REQ: DiagnoseRequest = {
  kind: "diagnose",
  sessionId: "tab-1",
  rustId: "pty-9",
  hostId: 1,
  hostName: "web-01",
  exitCode: 1,
  command: "$ df -h",
};

function reset(req: DiagnoseRequest | null, patch: Partial<ReturnType<typeof useAiStore.getState>> = {}) {
  useAiStore.setState({
    request: req,
    status: req ? "running" : "idle",
    answer: "",
    errorKind: null,
    error: null,
    redactions: [],
    settingsUsed: null,
    ...patch,
  });
}

beforeEach(() => {
  reset(null);
});

describe("extractCodeBlocks", () => {
  it("提取围栏代码块；未闭合尾部（流式中）也产出", () => {
    const blocks = extractCodeBlocks("原因 X\n```bash\ndf -h\n```\n说明\n```sh\ncd /var");
    expect(blocks.map((b) => b.code)).toEqual(["df -h", "cd /var"]);
  });
  it("空围栏不产出", () => {
    expect(extractCodeBlocks("```\n```")).toEqual([]);
  });
});

describe("面板渲染", () => {
  it("诊断请求头：exit 徽标 + 命令 + 思考中", () => {
    reset(REQ, { status: "running", answer: "" });
    render(<DiagnosePanel onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-exit-code").textContent).toContain("1");
    expect(screen.getByTestId("ai-request-cmd").textContent).toContain("df -h");
    expect(screen.getByTestId("ai-thinking")).toBeTruthy();
    expect(screen.getByTestId("ai-stop")).toBeTruthy();
  });

  it("脱敏计数展示", () => {
    reset(REQ, {
      status: "done",
      answer: "ok",
      redactions: [
        { name: "ipv4", count: 2 },
        { name: "password", count: 1 },
      ],
    });
    render(<DiagnosePanel onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-redactions").textContent).toContain("3");
  });

  it("流式答案渲染文本 + 代码块（插终端按钮在位）", () => {
    reset(REQ, { status: "done", answer: "原因是磁盘满。\n```bash\ndf -h\n```" });
    render(<DiagnosePanel onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-answer").textContent).toContain("原因是磁盘满。");
    expect(screen.getByTestId("ai-code-text").textContent).toBe("df -h");
    expect(screen.getByTestId("ai-insert")).toBeTruthy();
  });

  it("abort 态显示已取消；无请求返回 null", () => {
    reset(null);
    const first = render(<DiagnosePanel onOpenSettings={() => {}} />);
    expect(first.container.firstChild).toBeNull();
    first.unmount();
    reset(REQ, { status: "aborted" });
    render(<DiagnosePanel onOpenSettings={() => {}} />);
    expect(screen.getByText("已取消")).toBeTruthy();
  });

  it("noProvider 错误面：去设置按钮回调", () => {
    reset(REQ, { status: "error", errorKind: "noProvider" });
    const onOpenSettings = vi.fn();
    render(<DiagnosePanel onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTestId("ai-open-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("request 错误面：端点消息 + 重试", () => {
    reset(REQ, { status: "error", errorKind: "request", error: "HTTP 401: bad key" });
    render(<DiagnosePanel onOpenSettings={() => {}} />);
    expect(screen.getByTestId("ai-error-message").textContent).toContain("HTTP 401");
    expect(screen.getByTestId("ai-retry")).toBeTruthy();
  });
});

describe("插终端三档确认状态机", () => {
  const inserter = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    inserter.mockClear();
  });

  it("green：一键直插（rustId 在位）", async () => {
    reset(REQ, { status: "done", answer: "```bash\ndf -h\n```" });
    render(<DiagnosePanel onOpenSettings={() => {}} inserter={inserter} />);
    fireEvent.click(screen.getByTestId("ai-insert"));
    await vi.waitFor(() => {
      expect(inserter).toHaveBeenCalledWith("pty-9", "df -h");
      expect(screen.getByTestId("ai-insert").getAttribute("data-stage")).toBe("inserted");
    });
  });

  it("yellow：第一击确认文案，第二击才插", async () => {
    reset(REQ, { status: "done", answer: "```bash\nsudo reboot\n```" });
    render(<DiagnosePanel onOpenSettings={() => {}} inserter={inserter} />);
    const btn = screen.getByTestId("ai-insert");
    fireEvent.click(btn);
    expect(inserter).not.toHaveBeenCalled();
    expect(btn.getAttribute("data-stage")).toBe("confirm");
    fireEvent.click(btn);
    await vi.waitFor(() => {
      expect(inserter).toHaveBeenCalledWith("pty-9", "sudo reboot");
    });
  });

  it("red：两击（armed 红字）才插", async () => {
    reset(REQ, { status: "done", answer: "```bash\nrm -rf /tmp/build\n```" });
    render(<DiagnosePanel onOpenSettings={() => {}} inserter={inserter} />);
    const btn = screen.getByTestId("ai-insert");
    fireEvent.click(btn);
    expect(inserter).not.toHaveBeenCalled();
    expect(btn.getAttribute("data-stage")).toBe("armed");
    fireEvent.click(btn);
    await vi.waitFor(() => {
      expect(inserter).toHaveBeenCalledWith("pty-9", "rm -rf /tmp/build");
    });
  });

  it("rustId 为空（未连接）：按钮禁用", () => {
    reset({ ...REQ, rustId: null }, { status: "done", answer: "```bash\ndf -h\n```" });
    render(<DiagnosePanel onOpenSettings={() => {}} inserter={inserter} />);
    expect((screen.getByTestId("ai-insert") as HTMLButtonElement).disabled).toBe(true);
  });

  it("危险等级徽标随命令分档", () => {
    reset(REQ, { status: "done", answer: "```bash\nrm -rf /\n```" });
    render(<DiagnosePanel onOpenSettings={() => {}} inserter={inserter} />);
    expect(screen.getByTestId("ai-code-level").textContent).toBe("危险");
  });
});
