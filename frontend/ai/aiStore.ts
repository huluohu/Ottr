// AI 诊断 store（Task 13，核心卖点链路；2026-10-19 方案 A 会话作用域化）：
//   exit_code≠0（xterm OSC133 监听，CommandWatch）→ openDiagnose → run：
//   读 settings → session_tail(rustId, 8KB) → 脱敏（redact）→ provider.chat
//   流式渲染 → 完成落通知（notify kind="ai"，T12 管线预留位）。
// 选中解释（右键「解释」）→ openExplain → 同一 run 链（单轮，无 tail）。
//
// **会话作用域（2026-10-19 用户裁定方案 A）**：面板状态按 sessionId 各自一份
// （sessions 映射）——任何会话的失败只写自己那份，面板只渲染在所属会话的
// 终端视图旁；后台会话失败不再抢当前视图（页签「待看」琥珀点引导，DiagnosePanel
// 挂载即 markSeen）。此前全局单槽的三个问题（后台弹窗打断 / 无主机归属 /
// 「插入终端」错写他台 PTY 的危险面）随作用域化一并消除。并发流允许（每会话
// 独立 AbortController，A 会话流式中 B 失败互不干扰）。
//
// 裁定与护栏：
// * BYOK 直连：provider 明文 key 只经 vault secrets 单点出库 → createProvider
//   闭包/请求头，不落任何 store/state；
// * abort：AbortController 收口在 store（面板按钮 → abort），AbortError
//   归为 aborted 态而非 error（用户主动取消不是故障）；**按会话隔离**——
//   关闭/取消某会话面板绝不波及其他会话的在途流；
// * 未配置 provider / key：status="error" + noProvider/noKey 标记，面板引导
//   去设置页（不静默失败）；
// * 通知失败绝不反噬诊断链路（与 notify/core 纪律一致）。
// * 会话收尾清理：App 把 dropSession 搭在既有 setSessionEndHook 钩子上
//   （store 纯状态机、不反向依赖 AI 链路的既有惯例不变）。
import { create } from "zustand";
import i18n from "../i18n";
import { notify } from "../notify/core";
import { vaultApi } from "../vault/api";
import { createProvider, type ChatMessage } from "./provider";
import { redact, type RedactFinding } from "./redact";
import {
  TAIL_BYTES,
  activeProvider,
  apiKeySecretKey,
  loadAiSettings,
  type AiSettings,
} from "./settings";

/** 诊断请求（exit_code≠0 自动触发 / 手动重试同面）。 */
export interface DiagnoseRequest {
  kind: "diagnose";
  sessionId: string;
  /** Rust 侧会话 id（session_tail 取数；null = 未连接） */
  rustId: string | null;
  hostId: number | null;
  hostName: string;
  exitCode: number | null;
  /** 触发诊断的命令行（含提示符原文；脱敏在 run 内做） */
  command: string;
}

/** 选中解释请求（右键菜单）。 */
export interface ExplainRequest {
  kind: "explain";
  sessionId: string;
  hostId: number | null;
  hostName: string;
  /** 选区文本（脱敏在 run 内做） */
  text: string;
}

export type AiRequest = DiagnoseRequest | ExplainRequest;

export type AiStatus = "idle" | "running" | "done" | "aborted" | "error";

/** 错误细分（面板引导用）：未配 provider / 未配 key / 端点与网络错误。 */
export type AiErrorKind = "noProvider" | "noKey" | "request";

/** 单会话的 AI 面板状态切片（诊断/解释共用同一份）。 */
export interface SessionAiState {
  request: AiRequest | null;
  status: AiStatus;
  answer: string;
  errorKind: AiErrorKind | null;
  error: string | null;
  /** 脱敏命中（面板展示「已脱敏 N 处」）。 */
  redactions: RedactFinding[];
  /** 本轮设置快照（面板展示 provider/model；run 前为 null）。 */
  settingsUsed: AiSettings | null;
  /** 面板已被用户看过（页签「待看」徽标 = 有 request 且未看过）。 */
  seen: boolean;
}

const EMPTY_SLICE: SessionAiState = {
  request: null,
  status: "idle",
  answer: "",
  errorKind: null,
  error: null,
  redactions: [],
  settingsUsed: null,
  seen: false,
};

interface AiStore {
  /** 按会话 id 的面板状态（方案 A：无全局槽，一切读写经 sessionId）。 */
  sessions: Record<string, SessionAiState>;

  /** exit_code≠0 入口（ai.enabled=false 时静默丢弃——总开关只管自动触发；
   * 手动「解释」不受限）。开关现读 settings（失败按开处理——诊断是能力面，
   * 配置读不出不该变哑）。只写 req.sessionId 自己的切片（同会话新失败取代
   * 旧面板；**他会话面板不受影响**——方案 A 与旧全局单槽的本质分野）。 */
  onCommandFailed: (req: DiagnoseRequest) => void;
  /** 右键「解释」入口（不受 ai.enabled 管——用户显式动作）。 */
  openExplain: (req: ExplainRequest) => void;
  /** 关闭某会话的面板（在途请求一并 abort；不影响他会话）。 */
  close: (sessionId: string) => void;
  /** 取消某会话的在途流（面板停止按钮）：面板保留、status 落 aborted
   * （用户主动取消不是故障）；非运行态调用是 no-op。 */
  abort: (sessionId: string) => void;
  /** 标记面板已被看过（清除页签「待看」徽标；DiagnosePanel 挂载时调用）。 */
  markSeen: (sessionId: string) => void;
  /** 会话收尾清理（App 搭 setSessionEndHook 钩子；abort + 摘除切片）。 */
  dropSession: (sessionId: string) => void;
  /** 执行/重试当前会话的请求。 */
  run: (sessionId: string) => Promise<void>;
}

/** 各会话在途请求的取消器（模块级——非响应式资源，与 sinks/定时器同一放置惯例）。 */
const controllers = new Map<string, AbortController>();

/** 面板打开时路由到设置页的钩子（App 挂载时注入，避免 store 反向依赖组件）。 */
let openSettingsHook: (() => void) | null = null;
export function setAiSettingsOpener(fn: (() => void) | null): void {
  openSettingsHook = fn;
}
export function openAiSettings(): void {
  openSettingsHook?.();
}

/** 组装诊断/解释的用户消息（脱敏后调用；格式稳定便于模型按段作答）。 */
export function buildUserMessage(req: AiRequest, redactedSubject: string, output: string): string {
  if (req.kind === "diagnose") {
    return [
      `${i18n.t("ai.msg.exitCode")}: ${req.exitCode ?? "?"}`,
      `${i18n.t("ai.msg.command")}:`,
      redactedSubject,
      `${i18n.t("ai.msg.outputTail")}:`,
      "```",
      output,
      "```",
    ].join("\n");
  }
  return `${i18n.t("ai.msg.explainTarget")}:\n${redactedSubject}`;
}

/** 通知正文的命令摘要（首行、80 字符截断；已脱敏文本入通知）。 */
export function commandExcerpt(command: string): string {
  const first = command.split("\n")[0] ?? command;
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

/** 自动诊断触发门槛（2026-10-19 用户反馈）：Ctrl+C（SIGINT → 130）是用户
 * 主动取消，不是需要诊断的失败——不弹面板（历史入库不受影响，onCommandFinished
 * 照记；手动「解释」也不受限）。仅 130：SIGTERM/SIGKILL 等仍照常诊断。 */
export function shouldAutoDiagnose(exitCode: number | null): boolean {
  return exitCode !== null && exitCode !== 130;
}

export const useAiStore = create<AiStore>((set, get) => {
  /** 切片更新（不存在则落入空切片底上合并；调用方保证 id 非空）。 */
  const patch = (sessionId: string, partial: Partial<SessionAiState>): void => {
    set((st) => {
      const cur = st.sessions[sessionId] ?? EMPTY_SLICE;
      return {
        sessions: { ...st.sessions, [sessionId]: { ...cur, ...partial } },
      };
    });
  };
  const slice = (sessionId: string): SessionAiState =>
    get().sessions[sessionId] ?? EMPTY_SLICE;

  return {
    sessions: {},

    onCommandFailed: (req) => {
      void (async () => {
        try {
          const s = await loadAiSettings();
          if (!s.enabled) return;
        } catch {
          // settings 读不到：按开处理（能力面不因配置故障变哑）
        }
        controllers.get(req.sessionId)?.abort();
        controllers.delete(req.sessionId);
        patch(req.sessionId, {
          request: req,
          status: "idle",
          answer: "",
          errorKind: null,
          error: null,
          seen: false,
        });
        await get().run(req.sessionId);
      })();
    },

    openExplain: (req) => {
      controllers.get(req.sessionId)?.abort();
      controllers.delete(req.sessionId);
      patch(req.sessionId, {
        request: req,
        status: "idle",
        answer: "",
        errorKind: null,
        error: null,
        seen: false,
      });
      void get().run(req.sessionId);
    },

    close: (sessionId) => {
      controllers.get(sessionId)?.abort();
      controllers.delete(sessionId);
      set((st) => {
        if (!(sessionId in st.sessions)) return st;
        const next = { ...st.sessions };
        delete next[sessionId];
        return { sessions: next };
      });
    },

    abort: (sessionId) => {
      controllers.get(sessionId)?.abort();
      controllers.delete(sessionId);
      if (slice(sessionId).status === "running") {
        patch(sessionId, { status: "aborted" });
      }
    },

    markSeen: (sessionId) => {
      if (slice(sessionId).request != null) patch(sessionId, { seen: true });
    },

    dropSession: (sessionId) => {
      get().close(sessionId);
    },

    run: async (sessionId) => {
      const req = slice(sessionId).request;
      if (!req) return;
      patch(sessionId, {
        status: "running",
        answer: "",
        errorKind: null,
        error: null,
        redactions: [],
      });

      // --- 1. 设置（坏键独立回落）---
      let settings: AiSettings;
      try {
        settings = await loadAiSettings();
      } catch (e) {
        patch(sessionId, {
          status: "error",
          errorKind: "noProvider",
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      patch(sessionId, { settingsUsed: settings });
      // 首个未禁用的 provider（启用/禁用 2026-10-16）：禁用的默认项自动旁路，
      // 无可用（未配置或全部禁用）→ noProvider 错误面（带去设置引导）。
      const meta = activeProvider(settings.providers);
      if (!meta) {
        patch(sessionId, { status: "error", errorKind: "noProvider", error: null });
        return;
      }

      // --- 2. 明文 key 单点出库（vault secrets）---
      // key 未保存 → **空串**（fix 1/5 I-1）：openai-compatible 显式允许免 key
      // （Ollama 本地端点；OpenAICompatibleProvider 对空 key 不发 Authorization 头）。
      // Anthropic 需要 key 的校验在设置页保存侧（errKeyRequired）；这里空 key 直连
      // 会拿到端点 401 → request 错误面，不在此二次设卡。
      let apiKey: string;
      try {
        apiKey = (await vaultApi.secrets.get(apiKeySecretKey(meta.id))) ?? "";
      } catch (e) {
        patch(sessionId, {
          status: "error",
          errorKind: "noKey",
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      // --- 3. 组装上下文：脱敏（命令/选区 + 输出尾 8KB）---
      const redactOpts = {
        hostname: settings.redaction.hostname,
        custom: settings.redaction.custom,
      };
      const subject = redact(req.kind === "diagnose" ? req.command : req.text, redactOpts);
      let outputTail = "";
      let outputRedactions: RedactFinding[] = [];
      if (req.kind === "diagnose" && req.rustId) {
        try {
          const tail = await vaultApi.sessionTail(req.rustId, TAIL_BYTES);
          const red = redact(tail, redactOpts);
          outputTail = red.text;
          outputRedactions = red.findings;
        } catch {
          // 会话已关/迟到：空输出照发诊断（命令本身通常已足够定位）
        }
      }
      patch(sessionId, {
        redactions: [...subject.findings, ...outputRedactions],
      });

      // 空内容不诊断（2026-10-21 用户裁定，AI 层的第二道防线）：命令与输出
      // 尾都为空 = 无从诊断（模型只能回复「内容为空」，纯烧 token）——摘除
      // 本会话面板切片，请求不发。watch 层已有首道门卫（首个 D + 空命令文本），
      // 这里兜住其余路径（迟到的空 tail、未来新入口）。手动「解释」不受限
      // （选区非空才可达菜单）。
      if (
        req.kind === "diagnose" &&
        subject.text.trim() === "" &&
        outputTail.trim() === ""
      ) {
        controllers.delete(sessionId);
        useAiStore.setState((s0) => {
          const next = { ...s0.sessions };
          delete next[sessionId];
          return { sessions: next };
        });
        return;
      }

      // --- 4. 流式（BYOK 直连；取消器按会话隔离）---
      const messages: ChatMessage[] = [
        { role: "user", content: buildUserMessage(req, subject.text, outputTail) },
      ];
      const ac = new AbortController();
      controllers.set(sessionId, ac);
      try {
        const provider = createProvider(meta, apiKey);
        for await (const delta of provider.chat({
          system: i18n.t(req.kind === "diagnose" ? "ai.prompt.diagnose" : "ai.prompt.explain"),
          messages,
          maxTokens: settings.maxTokens,
          signal: ac.signal,
        })) {
          if (controllers.get(sessionId) !== ac) return; // 已被本会话新一轮取代/关闭
          if (ac.signal.aborted) break;
          patch(sessionId, { answer: slice(sessionId).answer + delta.text, status: "running" });
        }
        if (controllers.get(sessionId) === ac) {
          controllers.delete(sessionId);
          const done = !ac.signal.aborted;
          patch(sessionId, { status: done ? "done" : "aborted" });
          if (done) {
            // --- 5. 完成落通知（T12 管线预留位；取消不发；失败只记 console 不反噬）---
            try {
              await notify({
                kind: "ai",
                severity: "success",
                host_id: req.hostId,
                title_key: req.kind === "diagnose" ? "notify.title.aiDone" : "notify.title.aiExplain",
                body: commandExcerpt(subject.text),
                payload: { session_id: req.sessionId, provider: meta.name },
              });
            } catch (e) {
              console.warn("[ai] notify failed:", e);
            }
          }
        }
      } catch (e) {
        if (controllers.get(sessionId) !== ac) return;
        controllers.delete(sessionId);
        if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
          patch(sessionId, { status: "aborted" });
          return;
        }
        patch(sessionId, {
          status: "error",
          errorKind: "request",
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (controllers.get(sessionId) === ac) controllers.delete(sessionId);
      }
    },
  };
});

/** 便捷选择器：会话切片（无则空切片——组件侧免 undefined 分支）。 */
export function useSessionAi(sessionId: string): SessionAiState {
  return useAiStore((s) => s.sessions[sessionId]) ?? EMPTY_SLICE;
}
