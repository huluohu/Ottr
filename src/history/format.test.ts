// 历史命令展示/复用工具测试（Task 15）：提示符剥离的保守启发式 + 预览截断。
import { describe, expect, it } from "vitest";
import { historyPreview, historyTime, stripPromptPrefix } from "./format";

describe("stripPromptPrefix（保守启发式：宁可漏剥不可错剥）", () => {
  it("常见提示符形态剥到命令本体", () => {
    expect(stripPromptPrefix("root@debian:~# docker ps")).toBe("docker ps");
    expect(stripPromptPrefix("user@web:/var/log$ ls -la")).toBe("ls -la");
    expect(stripPromptPrefix("bash-5.1$ git status")).toBe("git status");
    expect(stripPromptPrefix("% ./run.sh")).toBe("./run.sh");
    expect(stripPromptPrefix("$ plain")).toBe("plain");
  });

  it("命令体内的 $ 不受影响（惰性停在首个 提示符字符+空白）", () => {
    expect(stripPromptPrefix("user@h:~$ echo $HOME")).toBe("echo $HOME");
    expect(stripPromptPrefix("root@h:~$ echo a && echo b")).toBe("echo a && echo b");
  });

  it("行首含空格 / 动词直连重定向不剥（无空白 token 形态不命中）", () => {
    expect(stripPromptPrefix("echo hello")).toBe("echo hello");
    expect(stripPromptPrefix("cat > f")).toBe("cat > f");
    expect(stripPromptPrefix("  indented$ x")).toBe("  indented$ x");
  });

  it("多行命令只剥首行（续行是用户输入延续）", () => {
    expect(stripPromptPrefix("root@h:~$ echo one \\\n  && echo two")).toBe(
      "echo one \\\n  && echo two",
    );
  });

  it("无提示符的纯命令原样返回", () => {
    expect(stripPromptPrefix("docker logs --tail 100 ottr-api")).toBe(
      "docker logs --tail 100 ottr-api",
    );
  });
});

describe("historyPreview / historyTime", () => {
  it("预览取首行、超长截断（完整文本留给 title）", () => {
    expect(historyPreview("echo one\necho two")).toBe("echo one");
    expect(historyPreview("x".repeat(201))).toHaveLength(201);
  });

  it("时间列：秒级 Unix 时间戳渲染为非空串（本地格式不钉死）", () => {
    expect(historyTime(0)).not.toBe("");
    expect(historyTime(1_760_000_000)).toMatch(/\d/);
  });
});
