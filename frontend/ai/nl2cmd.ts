// NL→命令（Phase 2 B1，⌘J）：自然语言 → 单轮生成**单条命令**（流式）→
// danger 红黄绿分级 → 三档确认插终端（复用 T13 DiagnosePanel 的 InsertRow）。
//
// 裁定（对齐 task-6 简报）：
// * 用户输入与 cwd 原样发往所选端点，不做脱敏；可能包含敏感信息。
// * prompt 仅是生成提示；客户端保留多行与控制字符，公共 InsertRow
//   在写 PTY 前拒绝它们。danger 分级不是脱敏或防自动执行的安全边界。
// * 上下文可带当前目录（OSC7 cwd，CwdTracker 活值）——「在这里解压」这类
//   相对意图的目录锚点；无上报（shell 无集成）= null，prompt 不提目录。
// * ai.enabled 总开关**不管**本面板：⌘J 是显式用户动作，与右键「解释」同口径
//   （总开关只管 exit_code≠0 的自动触发）。
// * 完成不落通知：面板是用户注视中的轻量输入条，通知是噪音（诊断面板落通知
//   是因为它由后台失败事件触发）。
// * 完成轮入 rounds 账（批次三 T2，审计 ⌘J「生成结果无历史」）：面板「最近
//   生成」区回看往轮（含重开后），close/begin 不清、容量封顶（NL_ROUNDS_CAP）。
import { create } from "zustand";
import i18n from "../i18n";
import { vaultApi } from "../vault/api";
import { createProvider, type ChatMessage } from "./provider";
import { apiKeySecretKey, loadAiSettings, type AiSettings } from "./settings";
import { classify, type TrafficLight } from "./danger";

/** NL 生成请求的装配面（纯函数；nlStore 消费，测试直接断言）。 */
export interface Nl2cmdPrompt {
  system: string;
  user: string;
  /** 端点侧停止序列（ChatRequest.stop 直通）。 */
  stop: string[];
}

/** 装配 system/用户消息/stop（i18n 模板；cwd 有值才带目录锚点段）。 */
export function buildNl2cmdPrompt(
  input: string,
  opts: { cwd?: string | null } = {},
): Nl2cmdPrompt {
  const cwdLine = opts.cwd
    ? `${i18n.t("ai.nl2cmd.cwd")}: ${opts.cwd}\n\n`
    : "";
  return {
    system: i18n.t("ai.nl2cmd.prompt"),
    user: `${cwdLine}${input}`,
    // Do not truncate at a newline: a prefix can change multiline shell semantics.
    stop: [],
  };
}

/** Remove presentation wrappers only. Preserve multiline/control content so the
 * shared insertion guard can reject it without silently changing shell semantics. */
export function sanitizeNlCommand(raw: string): string {
  let text = raw.replace(/^ +| +$/g, "");
  if (text === "") return "";
  const fence = /^```[^\r\n]*\r?\n([\s\S]*?)(?:``` *$|$)/.exec(text);
  if (fence) {
    text = fence[1].replace(/\r?\n$/, "");
  } else if (/^`{3,}/.test(text)) {
    return "";
  }
  const inline = /^`([^`]+)`$/.exec(text);
  if (inline) text = inline[1];
  // Only literal spaces: \s would silently swallow control characters.
  return text.replace(/^\$ +/, "").replace(/^ +| +$/g, "");
}

// --- 运行链 store（面板开关在 App state，与 palette/history 同惯例） ----------

export type NlStatus = "idle" | "running" | "done" | "aborted" | "error";

/** 错误细分：未配 provider / 读 key 失败 / 端点错误 / 空结果（无可用命令）。 */
export type NlErrorKind = "noProvider" | "noKey" | "request" | "empty";

/** 一轮已完成的生成（批次三 T2，审计 ⌘J 21/22「生成结果无历史」）：输入原文
 * + sanitize 产物 + danger 分档。面板生命周期 = webview 会话级：close/begin
 * 均不清（「不随失焦/重开丢结果」的回看面），仅容量封顶防无界增长。 */
export interface NlRound {
  input: string;
  command: string;
  level: TrafficLight;
  ts: number;
}

/** 保留最近 N 轮（模块级 store 无持久化需求，与限频/锁存表同款口径）。 */
export const NL_ROUNDS_CAP = 10;

interface NlStore {
  input: string;
  status: NlStatus;
  /** 流式原文（面板等宽渲染；done 后面板改显 command）。 */
  answer: string;
  /** done 后 sanitize 产物（插入面；空串归为 empty 错误，不落这里）。 */
  command: string | null;
  /** 生成命令的 danger 分档（出口防线；done 时随 command 一并计算）。 */
  level: TrafficLight;
  errorKind: NlErrorKind | null;
  error: string | null;
  /** 本轮设置快照（面板展示 provider/model；run 前为 null）。 */
  settingsUsed: AiSettings | null;
  /** 打开面板时锚定的当前目录（OSC7 活值；无则 null）。 */
  cwd: string | null;
  /** 已完成轮次（最新在前；done 时追加。close/begin 不清——回看面）。 */
  rounds: NlRound[];

  /** 打开时重置（App 持开关；cwd 由 CwdTracker 按聚焦 pane 查询注入）。 */
  begin: (cwd: string | null) => void;
  setInput: (v: string) => void;
  /** 生成（input 空白则 no-op；在途请求被新一轮取代，同 aiStore 口径）。 */
  submit: () => Promise<void>;
  /** 取消在途请求。 */
  abort: () => void;
  /** 关闭面板的清场（在途请求一并 abort；rounds 保留）。 */
  close: () => void;
}

/** 在途请求的取消器（模块级——非响应式资源，与 sinks/定时器同一放置惯例）。 */
let controller: AbortController | null = null;

export const useNlStore = create<NlStore>((set, get) => ({
  input: "",
  status: "idle",
  answer: "",
  command: null,
  level: "green",
  errorKind: null,
  error: null,
  settingsUsed: null,
  cwd: null,
  rounds: [],

  begin: (cwd) => {
    get().abort();
    set({
      input: "",
      status: "idle",
      answer: "",
      command: null,
      level: "green",
      errorKind: null,
      error: null,
      settingsUsed: null,
      cwd,
    });
  },

  setInput: (v) => set({ input: v }),

  abort: () => {
    controller?.abort();
    controller = null;
    if (get().status === "running") set({ status: "aborted" });
  },

  close: () => {
    get().abort();
    set({
      input: "",
      status: "idle",
      answer: "",
      command: null,
      level: "green",
      errorKind: null,
      error: null,
      settingsUsed: null,
      // rounds 刻意保留（批次三 T2）：面板重开可回看往轮结果
    });
  },

  submit: async () => {
    const input = get().input.trim();
    if (input === "") return;
    set({ status: "running", answer: "", command: null, errorKind: null, error: null });

    // --- 1. 设置（坏键独立回落，同 aiStore 口径）---
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

    // --- 2. 明文 key 单点出库（空串 = 免 key 端点，同 aiStore fix 1/5 I-1）---
    let apiKey: string;
    try {
      apiKey = (await vaultApi.secrets.get(apiKeySecretKey(meta.id))) ?? "";
    } catch (e) {
      set({
        status: "error",
        errorKind: "noKey",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    // --- 3. 输入与 cwd 不脱敏；生成结果不在服务端截断 ---
    const prompt = buildNl2cmdPrompt(input, { cwd: get().cwd });
    const messages: ChatMessage[] = [{ role: "user", content: prompt.user }];
    const ac = new AbortController();
    controller = ac;
    try {
      const provider = createProvider(meta, apiKey);
      for await (const delta of provider.chat({
        system: prompt.system,
        messages,
        maxTokens: settings.maxTokens,
        stop: prompt.stop,
        signal: ac.signal,
      })) {
        if (controller !== ac) return; // 已被新一轮取代
        if (ac.signal.aborted) break;
        set((st) => ({ answer: st.answer + delta.text, status: "running" }));
      }
      if (controller === ac) {
        controller = null;
        const done = !ac.signal.aborted;
        if (done) {
          const command = sanitizeNlCommand(get().answer);
          if (command === "") {
            set({ status: "error", errorKind: "empty", error: null });
          } else {
            // 出口防线：生成的命令过 danger 分级（红黄绿决定确认档）
            const level = classify(command).level;
            // 完成轮入账（最新在前，容量封顶）——面板「最近生成」回看面
            set((st) => ({
              status: "done",
              command,
              level,
              rounds: [{ input, command, level, ts: Date.now() }, ...st.rounds].slice(
                0,
                NL_ROUNDS_CAP,
              ),
            }));
          }
        } else {
          set({ status: "aborted" });
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
