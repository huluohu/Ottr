// NL→命令（Phase 2 B1，⌘J）：自然语言 → 单轮生成**单条命令**（流式）→
// danger 红黄绿分级 → 三档确认插终端（复用 T13 DiagnosePanel 的 InsertRow）。
//
// 裁定（对齐 task-6 简报）：
// * 输入（用户正在敲的自然语言）**不过 redact**——意图描述没有既成敏感面
//   （与诊断链路的「命令/输出已落盘」不同面），脱敏反而破坏语义（占位符进
//   prompt 会诱导模型照抄）；防线放在**出口**：生成的命令必须过 classify，
//   插终端走三档确认（red 二击红字），与 T13 同一状态机。
// * 只输出一条命令 = 三层防线：
//     1. system prompt 约束（单行、无解释、无围栏、无 $ 前缀，i18n 模板）；
//     2. stop 序列 ["\n"]——兼容端点（OpenAI `stop` / Anthropic `stop_sequences`）
//        在**端点侧**把输出钉在第一行；
//     3. sanitizeNlCommand 客户端兜底——不服从的端点（免费兼容端点爱加围栏/
//        解释）如实处理：围栏取内层、$ 前缀剥离、被 stop 截在围栏头的输出
//        判不可用（内容在第二行、永远收不到），不假装 stop 恒生效。
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
    stop: ["\n"],
  };
}

/**
 * 生成结果 → 单条命令（客户端兜底层；stop 序列失效的端点差异如实处理）：
 *   * 完整/未闭合围栏 → 取内层首行（模型无视「不要围栏」仍能取到命令）；
 *   * 被 stop 截在围栏头（"```bash"）→ 判不可用（""）——内容在下一行、
 *     永远收不到，宁可空错误重试也不把语言标签当命令；
 *   * 整行反引号内联代码（`cmd`）→ 取内层（话痨模型的常见包裹形态）；
 *   * "$ " 提示符前缀剥离（# 刻意不剥——注释转命令是语义反转）；
 *   * 恒取首行 + trim（stop 生效时本来就是单行，防御非单行漏网）。
 */
export function sanitizeNlCommand(raw: string): string {
  let text = raw.trim();
  if (text === "") return "";
  const fence = /```[^\n]*\n([^\n]*)/.exec(text);
  if (fence) {
    const inner = fence[1].trim();
    if (inner !== "") text = inner;
  } else if (/^`{3,}/.test(text)) {
    // 围栏头被 stop 序列截断（无换行可取）：内容永远没到，判不可用
    return "";
  }
  const inline = /^`([^`]+)`$/.exec(text);
  if (inline) text = inline[1];
  // 只剥 "$ " 提示符前缀——刻意不剥 "#"：把注释行转成可执行命令是语义反转，
  // 保守侧宁可让用户看到原样文本。
  text = text.replace(/^\$\s+/, "");
  return text.split("\n")[0].trim();
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

    // --- 3. 装配 + 流式（输入不过 redact，见文件头裁定）---
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
