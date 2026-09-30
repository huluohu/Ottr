// AI 诊断 store（Task 13，核心卖点链路）：
//   exit_code≠0（xterm OSC133 监听，CommandWatch）→ openDiagnose → run：
//   读 settings → session_tail(rustId, 8KB) → 脱敏（redact）→ provider.chat
//   流式渲染 → 完成落通知（notify kind="ai"，T12 管线预留位）。
// 选中解释（右键「解释」）→ openExplain → 同一 run 链（单轮，无 tail）。
//
// 裁定与护栏：
// * BYOK 直连：provider 明文 key 只经 vault secrets 单点出库 → createProvider
//   闭包/请求头，不落任何 store/state；
// * abort：AbortController 收口在 store（面板按钮 → abort()），AbortError
//   归为 aborted 态而非 error（用户主动取消不是故障）；
// * 未配置 provider / key：status="error" + noProvider/noKey 标记，面板引导
//   去设置页（不静默失败）；
// * 通知失败绝不反噬诊断链路（与 notify/core 纪律一致）。
import { create } from "zustand";
import i18n from "../i18n";
import { notify } from "../notify/core";
import { vaultApi } from "../vault/api";
import { createProvider, type ChatMessage } from "./provider";
import { redact, type RedactFinding } from "./redact";
import {
  TAIL_BYTES,
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

interface AiStore {
  request: AiRequest | null;
  status: AiStatus;
  answer: string;
  errorKind: AiErrorKind | null;
  error: string | null;
  /** 脱敏命中（面板展示「已脱敏 N 处」）。 */
  redactions: RedactFinding[];
  /** 本轮设置快照（面板展示 provider/model；run 前为 null）。 */
  settingsUsed: AiSettings | null;

  /** exit_code≠0 入口（ai.enabled=false 时静默丢弃——总开关只管自动触发；
   * 手动「解释」不受限）。开关现读 settings（失败按开处理——诊断是能力面，
   * 配置读不出不该变哑）。已有在途请求时：新失败取代旧面板（最新失败最相关）。 */
  onCommandFailed: (req: DiagnoseRequest) => void;
  /** 右键「解释」入口（不受 ai.enabled 管——用户显式动作）。 */
  openExplain: (req: ExplainRequest) => void;
  /** 关闭面板（在途请求一并 abort）。 */
  close: () => void;
  /** 取消在途请求（面板停止按钮）。 */
  abort: () => void;
  /** 执行/重试当前请求。 */
  run: () => Promise<void>;
}

/** 在途请求的取消器（模块级——非响应式资源，与 sinks/定时器同一放置惯例）。 */
let controller: AbortController | null = null;

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

export const useAiStore = create<AiStore>((set, get) => ({
  request: null,
  status: "idle",
  answer: "",
  errorKind: null,
  error: null,
  redactions: [],
  settingsUsed: null,

  onCommandFailed: (req) => {
    void (async () => {
      try {
        const s = await loadAiSettings();
        if (!s.enabled) return;
      } catch {
        // settings 读不到：按开处理（能力面不因配置故障变哑）
      }
      get().abort();
      set({ request: req, status: "idle", answer: "", errorKind: null, error: null });
      await get().run();
    })();
  },

  openExplain: (req) => {
    get().abort();
    set({ request: req, status: "idle", answer: "", errorKind: null, error: null });
    void get().run();
  },

  close: () => {
    get().abort();
    set({ request: null, status: "idle", answer: "", errorKind: null, error: null });
  },

  abort: () => {
    controller?.abort();
    controller = null;
    if (get().status === "running") set({ status: "aborted" });
  },

  run: async () => {
    const req = get().request;
    if (!req) return;
    set({ status: "running", answer: "", errorKind: null, error: null, redactions: [] });

    // --- 1. 设置（坏键独立回落）---
    let settings: AiSettings;
    try {
      settings = await loadAiSettings();
    } catch (e) {
      set({
        status: "error",
        errorKind: "noProvider",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    set({ settingsUsed: settings });
    const meta = settings.providers[0] ?? null;
    if (!meta) {
      set({ status: "error", errorKind: "noProvider", error: null });
      return;
    }

    // --- 2. 明文 key 单点出库（vault secrets；锁定/未配置显式报错）---
    let apiKey: string;
    try {
      const stored = await vaultApi.secrets.get(apiKeySecretKey(meta.id));
      if (stored === null) {
        set({ status: "error", errorKind: "noKey", error: null });
        return;
      }
      apiKey = stored;
    } catch (e) {
      set({
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
    set({ redactions: [...subject.findings, ...outputRedactions] });

    // --- 4. 流式（BYOK 直连）---
    const messages: ChatMessage[] = [
      { role: "user", content: buildUserMessage(req, subject.text, outputTail) },
    ];
    const ac = new AbortController();
    controller = ac;
    try {
      const provider = createProvider(meta, apiKey);
      for await (const delta of provider.chat({
        system: i18n.t(req.kind === "diagnose" ? "ai.prompt.diagnose" : "ai.prompt.explain"),
        messages,
        maxTokens: settings.maxTokens,
        signal: ac.signal,
      })) {
        if (controller !== ac) return; // 已被新一轮取代
        if (ac.signal.aborted) break;
        set((st) => ({ answer: st.answer + delta.text, status: "running" }));
      }
      if (controller === ac) {
        controller = null;
        const done = !ac.signal.aborted;
        set({ status: done ? "done" : "aborted" });
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
      if (controller !== ac) return;
      controller = null;
      if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        set({ status: "aborted" });
        return;
      }
      set({
        status: "error",
        errorKind: "request",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (controller === ac) controller = null;
    }
  },
}));
