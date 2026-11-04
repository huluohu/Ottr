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
//
// **目标绑定（ask-ottr-orb Task 3）**：nlBegin 捕获聚焦 pane 的不可变目标，
// 每轮 submit 开自己的 scope（ai_scope_open；插入授权 = 一次性 actionId），
// 完成轮随账携带来源 target/scopeId/runId——A 生成的旧轮永不改插当前聚焦
// 终端（跨目标禁用在公共 InsertRow 生产守卫内）。scope 收权口径（I-2）：
// supersede/abort 收**真正在途**的；settle（完成/中止/出错）只清指针不撤销
// ——完成轮授权保持到 close（lifecycle 失效全收）/ 后端 TTL。
import { create } from "zustand";
import i18n from "../i18n";
import { vaultApi } from "../vault/api";
import { createProvider, type ChatMessage, type ChatUsage } from "./provider";
import { activeProvider, apiKeySecretKey, loadAiSettings, type AiSettings } from "./settings";
import { classify, type TrafficLight } from "./danger";
import { buildHostContextBlock, fetchHostNotes } from "./hostContext";
import { aiSessionApi, type AiScopeTarget } from "./sessionApi";
import { isAiTargetLive } from "../session/aiTarget";
import { useSessionStore } from "../session/SessionStore";
import { newAiId } from "./aiStore";

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
  opts: { cwd?: string | null; hostContext?: string } = {},
): Nl2cmdPrompt {
  const cwdLine = opts.cwd
    ? `${i18n.t("ai.nl2cmd.cwd")}: ${opts.cwd}\n\n`
    : "";
  // 主机备忘段：持久化在 vault 的上下文（脱敏后）。排在用户输入**之前**——
  // 输入是本次诉求，备忘是背景事实，背景在前更符合模型读法。
  const contextBlock = opts.hostContext
    ? `${opts.hostContext}\n\n`
    : "";
  return {
    system: i18n.t("ai.nl2cmd.prompt"),
    user: `${cwdLine}${contextBlock}${input}`,
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
 * + sanitize 产物 + danger 分档 + **来源绑定**（target/scopeId/runId，Task 3：
 * 插入只认轮次自己的来源，绝不改插当前聚焦终端）。面板生命周期 = webview
 * 会话级：close/begin 均不清（「不随失焦/重开丢结果」的回看面），仅容量封顶
 * 防无界增长。 */
export interface NlRound {
  input: string;
  command: string;
  level: TrafficLight;
  ts: number;
  /** 生成该轮时的绑定目标（无连接 = null；插入面随之禁用）。 */
  target: AiScopeTarget | null;
  /** 该轮 run 开的 scope id（插入授权；无/已撤 = null）。 */
  scopeId: string | null;
  /** 该轮 run id（actionId 前缀）。 */
  runId: string;
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
  /** 打开面板时锚定的主机 id（本地终端 = null；用于取主机「备注」注入 AI 上下文）。 */
  hostId: number | null;
  /** 打开面板时捕获的不可变目标（Task 3；无连接 = null——插入禁用）。 */
  target: AiScopeTarget | null;
  /** 本轮 run 的 scope id（完成轮随账、settle 后保留供当前结果插入；close 清空）。 */
  scopeId: string | null;
  /** 本轮 run id（open 的 requestId + 插入 actionId 前缀）。 */
  runId: string | null;
  /** 本轮用量（2026-11-02 批次一 B 项）：端点回传的 token 数；不给 = null。 */
  usage: ChatUsage | null;
  /** 本轮实际使用的模型名（端点回传优先，回落 settings 快照）。 */
  modelUsed: string | null;
  /** 本轮耗时（毫秒）。 */
  elapsedMs: number | null;
  /** 已完成轮次（最新在前；done 时追加。close/begin 不清——回看面）。 */
  rounds: NlRound[];

  /** 打开时重置（App 持开关；cwd 由 CwdTracker 按聚焦 pane 查询注入，
   *  hostId 由聚焦会话解析，target 由聚焦 pane 定格（Task 3））。 */
  begin: (cwd: string | null, hostId?: number | null, target?: AiScopeTarget | null) => void;
  setInput: (v: string) => void;
  /** 生成（input 空白则 no-op；在途请求被新一轮取代，同 aiStore 口径）。 */
  submit: () => Promise<void>;
  /** 取消在途请求（在途 scope 一并撤销）。 */
  abort: () => void;
  /** 关闭面板的清场（在途请求一并 abort；scope 做 lifecycle 失效——在途 +
   *  已完成轮次全部收权；rounds 保留供回看，重开后旧轮插入按后端拒绝
   *  fail-closed 呈现）。 */
  close: () => void;
}

/** 在途请求的取消器（模块级——非响应式资源，与 sinks/定时器同一放置惯例）。 */
let controller: AbortController | null = null;
/**
 * 在途 run 的 scope id——**只**指向真正在途的 run（fix round 1 I-2）：
 * settle（完成/中止/出错）即清、**不撤销**——完成轮的插入授权保持有效，
 * 直到 (a) 后端 scope TTL（15 min）或 (b) 生命周期失效（close /
 * 源目标重连——后者由后端按 rust_id 失配拒）。指针只在 supersede（新一轮
 * submit）与 abort 时收权，绝不指到已完成轮上。
 */
let inflightScopeId: string | null = null;
/** 本面板全部活 scope（close 的 lifecycle 失效面：在途 + 已完成轮次一并收）。 */
const liveScopes = new Set<string>();

/** 撤销一个 scope（尽力而为；已撤销/过期/后端不可达一律吞掉）。 */
async function revokeScopeQuietly(scopeId: string): Promise<void> {
  try {
    await aiSessionApi.revoke(scopeId);
  } catch {
    // 撤销失败不反噬（后端 TTL 兜底）
  }
}

/** 收回**真正在途**的 scope（supersede/abort；settle 后指针已清——
 *  不会误伤已完成轮次的授权，I-2 的核心）。 */
async function revokeInflight(): Promise<void> {
  const scopeId = inflightScopeId;
  inflightScopeId = null;
  if (scopeId == null) return;
  liveScopes.delete(scopeId);
  await revokeScopeQuietly(scopeId);
}

/** close 的 lifecycle 失效：在途 + 全部已完成轮次的 scope 一并撤销。 */
async function revokeAllNlScopes(): Promise<void> {
  inflightScopeId = null;
  const ids = [...liveScopes];
  liveScopes.clear();
  await Promise.all(ids.map(revokeScopeQuietly));
}

/** SessionStore 切片 → isAiTargetLive 入参面。 */
function nlFocusState() {
  const s = useSessionStore.getState();
  return { activeId: s.activeId, activePane: s.activePane, sessions: s.sessions };
}

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
  hostId: null,
  target: null,
  scopeId: null,
  runId: null,
  usage: null,
  modelUsed: null,
  elapsedMs: null,
  rounds: [],

  begin: (cwd, hostId = null, target = null) => {
    void get().abort();
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
      hostId,
      target,
      scopeId: null,
      runId: null,
      usage: null,
      modelUsed: null,
      elapsedMs: null,
    });
  },

  setInput: (v) => set({ input: v }),

  abort: () => {
    controller?.abort();
    controller = null;
    void revokeInflight();
    if (get().status === "running") set({ status: "aborted" });
  },

  close: () => {
    void get().abort();
    void revokeAllNlScopes();
    set({
      input: "",
      status: "idle",
      answer: "",
      command: null,
      level: "green",
      errorKind: null,
      error: null,
      settingsUsed: null,
      scopeId: null,
      runId: null,
      usage: null,
      modelUsed: null,
      elapsedMs: null,
      // rounds 刻意保留（批次三 T2）：面板重开可回看往轮结果
    });
  },

  submit: async () => {
    const input = get().input.trim();
    if (input === "") return;
    // --- runId + AbortController 先于一切 await（Task 3 铁律）---
    const runId = newAiId("run");
    const ac = new AbortController();
    controller = ac;
    set({
      status: "running",
      answer: "",
      command: null,
      errorKind: null,
      error: null,
      usage: null,
      modelUsed: null,
      elapsedMs: null,
      scopeId: null,
      runId,
    });
    void revokeInflight(); // 被本 run 取代的上一条在途 scope 收权

    // --- 1. 设置（坏键独立回落，同 aiStore 口径）---
    let settings: AiSettings;
    try {
      settings = await loadAiSettings();
    } catch (e) {
      if (controller !== ac) return;
      set({
        status: "error",
        errorKind: "noProvider",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (controller !== ac) return;
    set({ settingsUsed: settings });
    // 首个未禁用的 provider（启用/禁用 2026-10-16）：全禁用 = 无可用 →
    // noProvider 错误面（带去设置引导）。
    const meta = activeProvider(settings.providers);
    if (!meta) {
      set({ status: "error", errorKind: "noProvider", error: null });
      return;
    }

    // --- 2. 明文 key 单点出库（空串 = 免 key 端点，同 aiStore fix 1/5 I-1）---
    let apiKey: string;
    try {
      apiKey = (await vaultApi.secrets.get(apiKeySecretKey(meta.id))) ?? "";
    } catch (e) {
      if (controller !== ac) return;
      set({
        status: "error",
        errorKind: "noKey",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (controller !== ac) return;

    // --- 2.5 scope（Task 3）：目标活校验先行；插入授权随本轮走 ---
    const target = get().target;
    if (target && isAiTargetLive(target, nlFocusState())) {
      try {
        const scope = await aiSessionApi.open(target, `nl-${runId}`, runId);
        if (controller !== ac) {
          // 迟到的 open 结果：立即收权，不得授权被取代的 run
          if (scope?.scopeId) void aiSessionApi.revoke(scope.scopeId).catch(() => {});
          return;
        }
        if (scope?.scopeId) {
          inflightScopeId = scope.scopeId;
          liveScopes.add(scope.scopeId);
          set({ scopeId: scope.scopeId });
        }
      } catch {
        // scope 开失败：照常生成，插入面禁用（无授权不写终端）
      }
    }

    // --- 3. 输入与 cwd 不脱敏；生成结果不在服务端截断 ---
    // 主机备注**要脱敏**（2026-11-02 批次一 A 项）：它是持久化在 vault 的
    // 另一份数据，不是用户本次输入——与「输入原样发端点」是两条不同纪律。
    const notes = await fetchHostNotes(get().hostId);
    if (controller !== ac) return;
    const hostCtx = buildHostContextBlock(notes, {
      hostname: settings.redaction.hostname,
      custom: settings.redaction.custom,
    });
    const hostContext = hostCtx.text ? `${i18n.t("ai.msg.hostContext")}:\n${hostCtx.text}` : "";
    const prompt = buildNl2cmdPrompt(input, { cwd: get().cwd, hostContext });
    const messages: ChatMessage[] = [{ role: "user", content: prompt.user }];
    const startedAt = performance.now();
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
        set((st) => ({
          answer: st.answer + delta.text,
          status: "running",
          usage: delta.usage ?? st.usage,
          modelUsed: delta.model ?? st.modelUsed,
        }));
      }
      if (controller === ac) {
        controller = null;
        // settle（完成/中止/出错）：清在途指针，**不撤销**——本轮（或未来轮）
        // 的插入授权保持有效到 close/lifecycle 失效/TTL（I-2）。
        inflightScopeId = null;
        const done = !ac.signal.aborted;
        set({ elapsedMs: Math.round(performance.now() - startedAt) });
        if (done) {
          const command = sanitizeNlCommand(get().answer);
          if (command === "") {
            set({ status: "error", errorKind: "empty", error: null });
          } else {
            // 出口防线：生成的命令过 danger 分级（红黄绿决定确认档）
            const level = classify(command).level;
            // 完成轮入账（最新在前，容量封顶）——面板「最近生成」回看面。
            // 来源绑定随账（Task 3）：target/scopeId/runId 落轮。
            const boundTarget = get().target;
            const roundScopeId = get().scopeId;
            set((st) => ({
              status: "done",
              command,
              level,
              rounds: [
                {
                  input,
                  command,
                  level,
                  ts: Date.now(),
                  target: boundTarget,
                  scopeId: roundScopeId,
                  runId,
                },
                ...st.rounds,
              ].slice(0, NL_ROUNDS_CAP),
            }));
          }
        } else {
          set({ status: "aborted" });
        }
      }
    } catch (e) {
      if (controller !== ac) return;
      controller = null;
      // settle（出错）：清在途指针，不撤销（同 done/中止，I-2）。
      inflightScopeId = null;
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
