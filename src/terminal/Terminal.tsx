// SessionTerminal（Task 7，A6）：单会话终端视图——xterm.js + 会话数据面接线。
//
// 数据面沿用 Phase 0 定案：PTY 输出经 attach_host_session 的二进制 Raw 帧推到
// Channel（ArrayBuffer，见 docs/phase0-report.md），字节直写 xterm；击键经
// write_session 直传 PTY。与 Phase 0 spike 单页的差别：终端实例按标签持有
// （切标签不丢回显缓冲），生命周期 = 标签生命周期，重连复用同一实例（历史
// 滚回保留，重连横幅写进终端流）。
//
// 布局：终端常驻挂载（全部标签各一份），激活态由父级 data-active 控制显隐；
// ResizeObserver 在可见尺寸变化时 fit（隐藏 → 0 尺寸跳过，恢复可见自动重排）。
// 状态横幅：connecting/重连退避/断开原因写入终端流（与 shell 输出同一回放面）。
//
// Task 7 重构删项（台账裁定）：Phase 0 的 ?spike= 测量模式（OttrTerminal spike /
// RenderSpike / ThroughputSpike）随单页模式一并移除；attach_session 等命令面
// 保留在 Rust 侧供 scripts/ 驱动脚本使用。
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTranslation } from "react-i18next";
import "@xterm/xterm/css/xterm.css";
import { registerSink, unregisterSink, useSessionStore, isHostKeyRejection } from "../session/SessionStore";
import { useTheme } from "../theme/ThemeContext";
import { terminalThemes } from "../theme/terminal-themes";

/** 主题切换时同步 xterm 配色（亮/暗两套，A10）。 */
function applyTermTheme(term: XTerm, mode: "light" | "dark" | "system"): void {
  const effective =
    mode === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
  term.options.theme = terminalThemes[effective];
}

export function SessionTerminal({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { mode } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const prevStatus = useRef<string | null>(null);

  const status = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.status ?? "disconnected",
  );
  const attempt = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.attempt ?? 0,
  );
  const nextRetryAt = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.nextRetryAt ?? null,
  );
  const lastError = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.lastError ?? null,
  );

  // --- 一次性装配：term 实例 + sink 注册 + 击键接线 + 尺寸观测 ---
  useEffect(() => {
    const term = new XTerm({ cursorBlink: true, fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    if (hostRef.current) {
      try {
        term.open(hostRef.current);
      } catch {
        // 布局未就绪（隐藏窗格/测试环境）不阻塞；恢复可见时 RO 会再 fit
      }
    }
    applyTermTheme(term, mode);

    registerSink(sessionId, {
      write: (bytes) => term.write(bytes),
      getSize: () => {
        try {
          fit.fit();
        } catch {
          // 尺寸不可测（隐藏/未布局）→ xterm 默认值仍有效
        }
        return { cols: term.cols, rows: term.rows };
      },
    });

    // 击键 → PTY（rustId 实时读 store；重连换会话 id 后自动跟随）
    const onData = term.onData((d) => {
      const session = useSessionStore
        .getState()
        .sessions.find((x) => x.id === sessionId);
      if (!session?.rustId) return; // 未连接：击键落空（横幅已提示状态）
      void invoke("write_session", {
        id: session.rustId,
        bytes: Array.from(new TextEncoder().encode(d)),
      }).catch(() => {});
    });

    // 可见尺寸变化 → fit（切标签/拖侧栏/窗口缩放）。0 尺寸（隐藏）跳过。
    const ro = new ResizeObserver(() => {
      const el = hostRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        // xterm 对退化尺寸抛错可忽略
      }
    });
    if (hostRef.current) ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      onData.dispose();
      unregisterSink(sessionId);
      term.dispose();
      termRef.current = null;
    };
    // sessionId 是组件身份（key 绑定），mode 变化走单独 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // --- 主题跟随 ---
  useEffect(() => {
    if (termRef.current) applyTermTheme(termRef.current, mode);
  }, [mode]);

  // --- 状态横幅（写入终端流；跳过挂载首帧的 disconnected 初值） ---
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const first = prevStatus.current === null;
    prevStatus.current = status;
    if (first && status === "connecting") {
      // 首连中（挂载即 connecting）：连接横幅
      term.writeln(`\x1b[2m[ottr] ${t("terminal.connecting")}\x1b[0m`);
      return;
    }
    if (first) return; // 恢复的静默标签（disconnected）不写历史横幅
    switch (status) {
      case "connected":
        if (attempt === 0) break; // 首连成功：shell 输出即反馈，不打横幅
        term.writeln(`\x1b[2m[ottr] ${t("terminal.reconnected")}\x1b[0m`);
        break;
      case "reconnecting": {
        const seconds = nextRetryAt ? Math.max(1, Math.round((nextRetryAt - Date.now()) / 1000)) : 0;
        term.writeln(
          `\x1b[33m[ottr] ${t("terminal.reconnecting", {
            seconds,
            attempt,
            max: useSessionStore.getState().settings.maxReconnectAttempts,
          })}\x1b[0m`,
        );
        break;
      }
      case "disconnected":
        if (lastError) {
          term.writeln(
            isHostKeyRejection(lastError)
              ? `\x1b[31m[ottr] ${t("terminal.hostKeyRejected")}\x1b[0m`
              : `\x1b[31m[ottr] ${t("terminal.connectFailed", { message: lastError })}\x1b[0m`,
          );
        }
        if (attempt === 0) {
          term.writeln(`\x1b[2m[ottr] ${t("terminal.reconnectHint")}\x1b[0m`);
        } else {
          term.writeln(
            `\x1b[31m[ottr] ${t("terminal.reconnectExhausted", {
              max: useSessionStore.getState().settings.maxReconnectAttempts,
            })}\x1b[0m`,
          );
        }
        break;
      default:
        break;
    }
    // attempt 变化（重连计数推进）不单独写横幅——reconnecting 分支已带计数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, lastError]);

  return (
    <div className="session-term" ref={hostRef} data-session-id={sessionId} />
  );
}
