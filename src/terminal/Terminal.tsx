// Terminal.tsx（Task 4 产出，Task 5-10 复用）：
// xterm.js 前端 + `attach_session` 二进制通道（Raw → ArrayBuffer）+ `write_session` 击键写入。
//
// spike 模式（?spike=latency，由 OTTR_SPIKE=latency 自动导航进入）：
// 1. 先跑通道探针（Raw 16B / Raw 2KB / JSON-base64 对照，typeof+长度对账 → 定案证据）；
// 2. attach 后等 shell 稳定，`exec cat` 换成纯回显进程（无 prompt 噪声）；
// 3. 自动打 100 字符（间隔 20ms），performance.now() 记「发出 → term.write 收到回显」；
// 4. p50/p95 + 帧长对账 JSON POST 给 `spike_report_latency` 落盘 /tmp/ottr-latency.json
//    （取数机制：scripts/spike-latency.sh 轮询该文件后 kill dev server）。
//
// 吞吐模式（?spike=throughput，Task 7 / Spike #3，由 OTTR_SPIKE=throughput 自动导航进入）：
// `ThroughputSpike`（本文件下方具名导出）——rAF 冻结探测 + `cat /tmp/big100` 100MB
// 全量字节账目（前端收到 vs Rust 转发 vs 104857600+回显开销）+ `&interrupt=1` 自动
// 中断验证（drop_session → 进程端取消 + UI 立即可用）。
import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Task 2/3 容器化夹具（127.0.0.1:2222，密码 spike-pass，主机指纹 pin 在 Rust 侧）
const FIXTURE = {
  host: "127.0.0.1",
  port: 2222,
  username: "spike",
  password: "spike-pass",
};

// --- 延迟测量参数（简报 Step 3：100 字符、间隔 20ms） ---
const CHARS = 100;
const INTERVAL_MS = 20;
const BOOT_MS = 2000; // 等 shell prompt 稳定
const CAT_SETTLE_MS = 800; // 等 `exec cat` 生效
const WARMUP_MAX_CHARS = 600; // 预热上限（自适应提前停）
const WARMUP_INTERVAL_MS = 5;
const WARMUP_TARGET_P95 = 30; // 最近 20 个预热回显 p95 低于此值 = 已热，开始正式测量
const WARMUP_MIN_CHARS = 60; // 至少跑这么久再判稳
const WARMUP_DRAIN_MS = 300; // 等预热回显排干（'0' 不在 a-z，串窗只会计入 noise）
const GRACE_MS = 3000; // 等最后一批回显

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 阶段打点 → Rust 侧 dev log（自动化排障唯一可观测通道）。 */
const pageLog = (msg: string) => {
  void invoke("spike_log", { msg }).catch(() => {});
};

/** 定案证据：消息的运行时类型与长度（ArrayBuffer=真二进制；string=走了 base64/JSON）。 */
function classify(m: unknown): string {
  if (m instanceof ArrayBuffer) return `ArrayBuffer(${m.byteLength})`;
  if (typeof m === "string") return `string(len=${m.length})`;
  if (m instanceof Uint8Array) return `Uint8Array(${m.byteLength})`;
  return `${typeof m}`;
}

/** Rust Raw 帧应为 ArrayBuffer；string 仅在 Raw 失效（fallback/base64 对照）时出现。 */
function toBytes(m: unknown): Uint8Array {
  if (m instanceof ArrayBuffer) return new Uint8Array(m);
  if (m instanceof Uint8Array) return m;
  if (typeof m === "string") {
    const bin = atob(m); // base64 fallback 路径
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error(`unexpected channel message type: ${typeof m}`);
}

// --- 击键回显测量状态机 ---
type Harness = {
  mode: "boot" | "typing" | "done";
  sent: { code: number; t0: number }[];
  latencies: number[];
  expected: number; // 下一个待匹配回显字符的下标
  noise: number; // 不匹配期望字符的杂散字节（cat 模式下应为 0）
};

function feed(h: Harness, bytes: Uint8Array, now: number): void {
  if (h.mode !== "typing") return;
  for (const b of bytes) {
    const next = h.sent[h.expected];
    if (next !== undefined && b === next.code) {
      h.latencies.push(now - next.t0);
      h.expected++;
    } else {
      h.noise++;
    }
  }
}

function p95Of(xs: number[]): number {
  if (!xs.length) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.95 * s.length) - 1];
}

/** 通道探针：spike_probe_channel 在同一 Channel 上发三种帧，前端逐个记录 typeof/长度。 */
async function runProbe(): Promise<Record<string, string>> {
  const chan = new Channel<unknown>();
  const got: unknown[] = [];
  chan.onmessage = (m) => got.push(m);
  await invoke("spike_probe_channel", { onProbe: chan });
  const deadline = Date.now() + 5000;
  while (got.length < 3 && Date.now() < deadline) await sleep(20);
  return {
    raw_16b: got[0] !== undefined ? classify(got[0]) : "MISSING",
    raw_2048b: got[1] !== undefined ? classify(got[1]) : "MISSING",
    json_b64_16b: got[2] !== undefined ? classify(got[2]) : "MISSING",
  };
}

export default function OttrTerminal({ spike }: { spike?: "latency" }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);
  const [badge, setBadge] = useState(
    spike === "latency" ? "spike:latency 初始化…" : "connecting 127.0.0.1:2222…",
  );

  useEffect(() => {
    // StrictMode dev 双挂载防护：spike 页生命周期 = 窗口生命周期，只 attach 一次
    // （正式使用时 Task 5+ 按会话生命周期重建组件/通道）。
    // 注意不能在 cleanup 里置 disposed 标志去打断测量流程——StrictMode 的
    // effect→cleanup→effect 会把唯一在跑的 IIFE 标记为 disposed，导致测量中断。
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      // 看门狗：流程卡死（WebKit 偶发停滞）时也要落一份失败报告，
      // 驱动脚本才能快速失败并拿到卡住的阶段，而不是干等超时。
      let lastStage = "mounted";
      const watchdog = setTimeout(() => {
        pageLog(`watchdog fired at stage=${lastStage}`);
        void invoke("spike_report_latency", {
          payload: JSON.stringify({
            error: "flow stalled",
            stage: lastStage,
            elapsed_ms: 120_000,
          }),
        }).catch(() => {});
      }, 120_000);
      const clearWatchdog = () => clearTimeout(watchdog);
      const stage = (msg: string) => {
        lastStage = msg.length > 80 ? msg.slice(0, 80) : msg;
        pageLog(msg);
      };

      const term = new XTerm({ cursorBlink: true, fontSize: 13 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      if (hostRef.current) term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        // 布局未就绪不影响测量（cols/rows 已有默认值）
      }

      // --- 1. 二进制通道定案探针 ---
      stage("mounted, running probe");
      let probe: Record<string, string> | null = null;
      if (spike === "latency") {
        try {
          probe = await runProbe();
          term.writeln(`[probe] ${JSON.stringify(probe)}`);
          stage(`probe done: ${JSON.stringify(probe)}`);
        } catch (e) {
          term.writeln(`[probe] failed: ${e}`);
          stage(`probe failed: ${e}`);
        }
      }

      // --- 2. attach：PTY 输出经 Raw 帧推到 chan ---
      const chan = new Channel<unknown>();
      const harness: Harness = { mode: "boot", sent: [], latencies: [], expected: 0, noise: 0 };
      // 预热专用 harness：'0' 字符的回显匹配，用于判稳（不计入正式样本）
      const warmup: Harness = { mode: "boot", sent: [], latencies: [], expected: 0, noise: 0 };
      let activeHarness = warmup;
      let frames = 0;
      let frontBytes = 0;
      let firstType = "";
      let base64Seen = false;
      const frameSizes: number[] = [];

      chan.onmessage = (m) => {
        frames++;
        if (!firstType) firstType = classify(m);
        if (typeof m === "string") base64Seen = true;
        let bytes: Uint8Array;
        try {
          bytes = toBytes(m);
        } catch {
          return;
        }
        frameSizes.push(bytes.length);
        frontBytes += bytes.length;
        term.write(bytes);
        feed(activeHarness, bytes, performance.now());
      };

      let id: string;
      // attach 重试：spike 观测到偶发连接停滞（Rust 侧已限时 15s 失败），
      // 重试一次即可绕过，不影响测量语义。
      let attachErr: unknown = null;
      id = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          stage(`attach attempt ${attempt}`);
          id = await invoke<string>("attach_session", {
            host: FIXTURE.host,
            port: FIXTURE.port,
            username: FIXTURE.username,
            password: FIXTURE.password,
            cols: term.cols,
            rows: term.rows,
            onData: chan,
          });
          attachErr = null;
          break;
        } catch (e) {
          attachErr = e;
          stage(`attach attempt ${attempt} failed: ${e}`);
          await sleep(1000);
        }
      }
      if (attachErr !== null) {
        const e = attachErr;
        term.writeln(`\r\n[attach failed] ${e}`);
        setBadge(`attach 失败: ${e}`);
        // 失败也要落报告，驱动脚本才不会白等超时（报告带 error 字段便于排障）
        try {
          await invoke("spike_report_latency", {
            payload: JSON.stringify({ error: String(e), stage: "attach" }),
          });
        } catch {
          // 上报本身失败则只能靠日志排障
        }
        clearWatchdog();
        return;
      }

      // 击键 → PTY（与真人输入同一路径；spike 台账允许 JSON 数组编码）
      const sendInput = (text: string) =>
        invoke("write_session", {
          id,
          bytes: Array.from(new TextEncoder().encode(text)),
        });
      term.onData((d) => {
        void sendInput(d);
      });
      stage(`attached as ${id}`);

      if (spike !== "latency") {
        setBadge(`已连接 127.0.0.1:2222（首帧 ${firstType}）`);
        return;
      }

      // --- 3. 自动打字测量 ---
      term.writeln(`[spike] ${BOOT_MS}ms 后开始打 ${CHARS} 字符（间隔 ${INTERVAL_MS}ms）…`);
      await sleep(BOOT_MS);
      await sendInput("exec cat\n"); // 纯回显进程：内核 tty 逐键回显，无 prompt 噪声
      await sleep(CAT_SETTLE_MS);

      // --- 3a. 自适应预热：跑热 JIT/xterm 渲染器/IPC 路径，直到回显 p95 判稳
      // 或达上限。冷启动会把样本抬高数百 ms（一次性成本），必须挡在测量窗之外。
      term.writeln(`[spike] 预热（自适应，目标 p95 < ${WARMUP_TARGET_P95}ms）…`);
      warmup.mode = "typing";
      const warmupT0 = performance.now();
      for (let i = 0; i < WARMUP_MAX_CHARS; i++) {
        warmup.sent.push({ code: 48, t0: performance.now() }); // '0'
        await sendInput("0"); // '0' 不在测量字符集 a-z 内：串窗只计入 noise，不会错配
        await sleep(WARMUP_INTERVAL_MS);
        if (i >= WARMUP_MIN_CHARS && i % 20 === 0) {
          const recent = warmup.latencies.slice(-20);
          const covered = warmup.expected >= i - 5; // 回显基本跟上
          if (covered && p95Of(recent) < WARMUP_TARGET_P95) break;
        }
      }
      warmup.mode = "done";
      const warmupMs = performance.now() - warmupT0;
      const warmupP95 = p95Of(warmup.latencies.slice(-20));
      stage(
        `warmup done: chars=${warmup.sent.length} echoed=${warmup.expected} p95=${warmupP95?.toFixed(1)}ms ${warmupMs.toFixed(0)}ms`,
      );
      await sleep(WARMUP_DRAIN_MS); // 回显排干，防预热字符串进测量窗

      activeHarness = harness; // 切回正式测量 harness
      harness.mode = "typing";
      const typingStart = performance.now();
      for (let i = 0; i < CHARS; i++) {
        const ch = String.fromCharCode(97 + (i % 26));
        // t0 = 发出时刻；先登记再 invoke，防回显早于 invoke 应答到达时漏匹配
        harness.sent.push({ code: ch.charCodeAt(0), t0: performance.now() });
        await sendInput(ch);
        await sleep(INTERVAL_MS);
      }
      const typingMs = performance.now() - typingStart;
      const graceDeadline = performance.now() + GRACE_MS;
      while (harness.expected < CHARS && performance.now() < graceDeadline) await sleep(50);
      harness.mode = "done";
      stage(
        `typing done: n=${harness.latencies.length} expected=${harness.expected} noise=${harness.noise}`,
      );

      // --- 4. 统计 + 回传报告 ---
      const xs = [...harness.latencies].sort((a, b) => a - b);
      const pct = (q: number) =>
        xs.length ? +xs[Math.ceil(q * xs.length) - 1].toFixed(2) : null;
      const p50 = pct(0.5);
      const p95 = pct(0.95);
      const report = {
        meta: {
          host: `${FIXTURE.host}:${FIXTURE.port}`,
          user: FIXTURE.username,
          chars: CHARS,
          interval_ms: INTERVAL_MS,
          boot_ms: BOOT_MS,
          warmup: {
            target_p95_ms: WARMUP_TARGET_P95,
            actual_p95_ms: warmup.latencies.length ? +warmupP95.toFixed(2) : null,
            chars_sent: warmup.sent.length,
            chars_echoed: warmup.expected,
            ms: +warmupMs.toFixed(1),
            drain_ms: WARMUP_DRAIN_MS,
          },
          typing_ms: +typingMs.toFixed(1),
          // 合批窗口/上限的实际生效值以报告 rust 段为准（spike 实验会改变窗口）
          ua: navigator.userAgent,
          measured_at: new Date().toISOString(),
        },
        latency: {
          n: xs.length,
          p50,
          p95,
          min: xs.length ? +xs[0].toFixed(2) : null,
          max: xs.length ? +xs[xs.length - 1].toFixed(2) : null,
          samples: harness.latencies.map((v) => +v.toFixed(2)),
        },
        channel: {
          typeof_first: firstType,
          base64_seen: base64Seen,
          frames,
          front_bytes: frontBytes,
          frame_sizes: frameSizes,
          probe,
        },
        echo_noise_bytes: harness.noise,
      };
      try {
        const path = await invoke<string>("spike_report_latency", {
          payload: JSON.stringify(report),
        });
        stage(`report written: ${path}`);
        const verdict =
          !base64Seen && firstType.startsWith("ArrayBuffer")
            ? "binary(ArrayBuffer)"
            : "NOT-binary(见 probe)";
        setBadge(
          `p50 ${p50}ms | p95 ${p95}ms | n=${xs.length} | 通道=${verdict} | report=${path}`,
        );
        term.writeln(
          `\r\n[spike] done: n=${xs.length} p50=${p50}ms p95=${p95}ms 通道=${verdict}`,
        );
        term.writeln(`[spike] report -> ${path}`);
        clearWatchdog();
      } catch (e) {
        setBadge(`report 上报失败: ${e}`);
        term.writeln(`\r\n[spike] report 上报失败: ${e}`);
        pageLog(`report 上报失败: ${e}`);
      }
    })();
  }, [spike]);

  return (
    <div className="spike-root">
      <div className="spike-badge" id="spike-badge">
        {badge}
      </div>
      <div className="spike-term" ref={hostRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task 7 / Spike #3：100MB 吞吐与背压测量（?spike=throughput）
// 由 OTTR_SPIKE=throughput 自动导航进入；&interrupt=1 追加自动中断验证（Step 4）。
// 报告经 spike_report_latency 通道落盘（T4 既有取数机制复用，名称沿用），
// 驱动脚本 scripts/spike-throughput.sh 轮询取数。
// ---------------------------------------------------------------------------

const BIG_FILE = "/tmp/big100";
const BIG_FILE_BYTES = 104_857_600;
const FREEZE_GAP_MS = 250; // 简报 Step 1：帧间隔 > 250ms 计一次冻结
const FREEZE_SUSPEND_MS = 5000; // >5s 视为 rAF 停摆（窗口被遮挡/节流），单列不计冻结
const THP_BOOT_MS = 1500; // 等 shell prompt 稳定
const THP_POLL_MS = 200; // Rust 计数轮询周期（兼作 UI 活动信号：徽标 5Hz 刷新）
const THP_STABLE_POLLS = 6; // 连续 6 拍（≈1.2s）PTY 读无增长且前端追平 → 传输结束
const THP_TIMEOUT_MS = 120_000; // 传输硬超时（页面看门狗 150s 兜底）
const INTERRUPT_AT_BYTES = 8 * 1024 * 1024; // interrupt=1：收到 8MiB 后自动 drop_session

type RustStats = {
  pty_read_bytes: number;
  forwarded_bytes: number;
  frames: number;
  input_bytes: number;
  writes: number;
  send_failed_frames: number;
  send_failed_bytes: number;
  failed: boolean;
};

function summarizeSizes(sizes: number[]): {
  count: number;
  min: number;
  max: number;
  avg: number;
  first10: number[];
} {
  if (!sizes.length) return { count: 0, min: 0, max: 0, avg: 0, first10: [] };
  return {
    count: sizes.length,
    min: sizes.reduce((a, b) => Math.min(a, b), Infinity),
    max: sizes.reduce((a, b) => Math.max(a, b), 0),
    avg: +(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1),
    first10: sizes.slice(0, 10),
  };
}

export function ThroughputSpike() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);
  const [badge, setBadge] = useState("spike:throughput 初始化…");

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      const interrupt =
        new URLSearchParams(window.location.search).get("interrupt") === "1";

      // 看门狗：卡死也落失败报告，驱动脚本才能快速失败并拿到卡住阶段（同 Task 4）。
      let lastStage = "mounted";
      const watchdog = setTimeout(() => {
        pageLog(`watchdog fired at stage=${lastStage}`);
        void invoke("spike_report_latency", {
          payload: JSON.stringify({
            mode: "throughput",
            error: "flow stalled",
            stage: lastStage,
          }),
        }).catch(() => {});
      }, 150_000);
      const clearWatchdog = () => clearTimeout(watchdog);
      const stage = (msg: string) => {
        lastStage = msg.length > 80 ? msg.slice(0, 80) : msg;
        pageLog(msg);
      };

      // --- Step 1: rAF 冻结探测器（整场运行：attach、传输、中断全程） ---
      let freezes = 0;
      let rafSuspended = 0; // >5s 的 rAF 停摆（遮挡/节流），不与真冻结混计
      let maxGapMs = 0;
      let rafFrames = 0;
      let lastFrame = performance.now();
      let rafAlive = true;
      const rafStep = (t: number) => {
        if (!rafAlive) return;
        const gap = t - lastFrame;
        lastFrame = t;
        rafFrames++;
        if (gap > maxGapMs) maxGapMs = gap;
        if (gap > FREEZE_SUSPEND_MS) rafSuspended++;
        else if (gap > FREEZE_GAP_MS) freezes++;
        requestAnimationFrame(rafStep);
      };
      requestAnimationFrame(rafStep);

      const term = new XTerm({ fontSize: 13 });
      const fit = new FitAddon();
      term.loadAddon(fit);
      if (hostRef.current) term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        // 布局未就绪不影响测量
      }

      // --- Step 2: attach + 前端字节计数（term.write 收到的每一帧） ---
      const chan = new Channel<unknown>();
      let frames = 0;
      let frontBytes = 0;
      let lastDataAt = 0;
      let firstType = "";
      let base64Seen = false;
      const frameSizes: number[] = [];
      chan.onmessage = (m) => {
        frames++;
        if (!firstType) firstType = classify(m);
        if (typeof m === "string") base64Seen = true;
        let bytes: Uint8Array;
        try {
          bytes = toBytes(m);
        } catch {
          return;
        }
        frameSizes.push(bytes.length);
        frontBytes += bytes.length;
        lastDataAt = performance.now();
        term.write(bytes);
      };

      // attach 重试一次（同 Task 4：偶发连接停滞，Rust 侧已限时失败）
      let id = "";
      let attachErr: unknown = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          stage(`attach attempt ${attempt}`);
          id = await invoke<string>("attach_session", {
            host: FIXTURE.host,
            port: FIXTURE.port,
            username: FIXTURE.username,
            password: FIXTURE.password,
            cols: term.cols,
            rows: term.rows,
            onData: chan,
          });
          attachErr = null;
          break;
        } catch (e) {
          attachErr = e;
          stage(`attach attempt ${attempt} failed: ${e}`);
          await sleep(1000);
        }
      }
      if (attachErr !== null) {
        term.writeln(`\r\n[attach failed] ${attachErr}`);
        setBadge(`attach 失败: ${attachErr}`);
        await invoke("spike_report_latency", {
          payload: JSON.stringify({
            mode: "throughput",
            error: String(attachErr),
            stage: "attach",
          }),
        }).catch(() => {});
        clearWatchdog();
        return;
      }
      stage(`attached as ${id}`);

      const sendInput = (text: string) =>
        invoke("write_session", {
          id,
          bytes: Array.from(new TextEncoder().encode(text)),
        });

      await sleep(THP_BOOT_MS);
      term.writeln(`[spike] cat ${BIG_FILE}（${BIG_FILE_BYTES} B）…`);

      // --- 传输 + 轮询（轮询兼作 UI 活动信号：React 徽标 5Hz 刷新） ---
      const t0 = performance.now();
      lastDataAt = t0;
      let stats: RustStats | null = null;
      let maxLagBytes = 0; // 背压信号：Rust 已转发 − 前端已收到的最大积压
      const lagTrace: { t_ms: number; front: number; rust: number }[] = []; // 每 10 拍采样（2s 粒度）
      let pollN = 0;
      let stable = 0;
      let lastRead = -1;
      let interruptInfo: Record<string, unknown> | null = null;
      let endedBy: "completed" | "interrupted" | "timeout" | "failed" = "timeout";

      await sendInput(`cat ${BIG_FILE}\n`);

      while (performance.now() - t0 < THP_TIMEOUT_MS) {
        await sleep(THP_POLL_MS);
        let s: RustStats;
        try {
          s = await invoke<RustStats>("session_stats", { id });
        } catch (e) {
          stage(`session_stats failed: ${e}`);
          endedBy = "failed";
          break;
        }
        stats = s;
        pollN++;
        const lag = Math.max(0, s.forwarded_bytes - frontBytes);
        if (lag > maxLagBytes) maxLagBytes = lag;
        if (pollN % 10 === 1) {
          lagTrace.push({
            t_ms: +(performance.now() - t0).toFixed(0),
            front: frontBytes,
            rust: s.forwarded_bytes,
          });
        }
        setBadge(
          `接收 ${(frontBytes / 1048576).toFixed(1)} / 100.0 MiB | Rust 已转发 ${s.forwarded_bytes} | 冻结 ${freezes} | maxGap ${maxGapMs.toFixed(0)}ms`,
        );
        if (s.failed || s.send_failed_bytes > 0) {
          stage(`session failed flag on: send_failed_bytes=${s.send_failed_bytes}`);
          endedBy = "failed";
          break;
        }
        // --- Step 4（interrupt=1）：到达阈值即自动 drop session ---
        if (interrupt && frontBytes >= INTERRUPT_AT_BYTES) {
          const atBytes = frontBytes;
          const atStats = s;
          const dropReq0 = performance.now();
          await invoke("drop_session", { id });
          const dropInvokeMs = performance.now() - dropReq0;
          // UI 立即可用证据 1：drop 返回后到下一次 rAF 帧的时距
          const nextFrameMs = await new Promise<number>((res) => {
            const t = performance.now();
            requestAnimationFrame(() => res(performance.now() - t));
          });
          // 证据 2：旧会话已从进程端移除（session_stats 必须报 no such session）
          let postDropStats: string;
          try {
            await invoke("session_stats", { id });
            postDropStats = "STILL-ALIVE(取消失效!)";
          } catch (e) {
            postDropStats = `gone ok: ${e}`;
          }
          // 证据 3：立刻新开会话并打字回显（真实可用性）
          const chan2 = new Channel<unknown>();
          let postText = "";
          const dec = new TextDecoder();
          chan2.onmessage = (m) => {
            try {
              const b = toBytes(m);
              postText = (postText + dec.decode(b)).slice(-2000);
            } catch {
              // 忽略非二进制帧
            }
          };
          const attach2_0 = performance.now();
          const id2 = await invoke<string>("attach_session", {
            host: FIXTURE.host,
            port: FIXTURE.port,
            username: FIXTURE.username,
            password: FIXTURE.password,
            cols: term.cols,
            rows: term.rows,
            onData: chan2,
          });
          const postAttachMs = performance.now() - attach2_0;
          const echo0 = performance.now();
          await invoke("write_session", {
            id: id2,
            bytes: Array.from(new TextEncoder().encode("echo post-drop-ok\n")),
          });
          let echoOk = false;
          const echoDeadline = performance.now() + 5000;
          while (performance.now() < echoDeadline) {
            await sleep(50);
            if (postText.includes("post-drop-ok")) {
              echoOk = true;
              break;
            }
          }
          interruptInfo = {
            trigger_bytes: INTERRUPT_AT_BYTES,
            front_bytes_at_drop: atBytes,
            stats_at_drop: atStats,
            drop_invoke_ms: +dropInvokeMs.toFixed(2),
            next_frame_after_drop_ms: +nextFrameMs.toFixed(2),
            post_drop_stats_check: postDropStats,
            post_drop_attach_ms: +postAttachMs.toFixed(2),
            post_drop_session: id2,
            post_drop_echo_ok: echoOk,
            post_drop_echo_ms:
              echoOk ? +(performance.now() - echo0).toFixed(2) : -1,
            freezes_at_drop: freezes,
          };
          stage(
            `interrupted: drop=${dropInvokeMs.toFixed(1)}ms nextFrame=${nextFrameMs.toFixed(1)}ms reattach=${postAttachMs.toFixed(0)}ms echo_ok=${echoOk}`,
          );
          endedBy = "interrupted";
          break;
        }
        // --- 完成判定：PTY 读停 + 前端追平 Rust ---
        if (s.pty_read_bytes === lastRead && s.pty_read_bytes > 0 && lag <= 4096) {
          stable++;
          if (stable >= THP_STABLE_POLLS) {
            endedBy = "completed";
            break;
          }
        } else {
          stable = 0;
          lastRead = s.pty_read_bytes;
        }
      }
      rafAlive = false; // 冻结计数止于传输/中断结束（报告时刻即计数快照）
      const elapsedMs = performance.now() - t0;
      // 吞吐分母 = 最后一个数据字节到达时刻（剔除结束判定的 ~1.2s 稳定尾）
      const dataMs = Math.max(lastDataAt - t0, 1);
      const rateBytes = endedBy === "completed" ? BIG_FILE_BYTES : frontBytes;
      const account = stats
        ? {
            rust_pty_read_bytes: stats.pty_read_bytes,
            rust_forwarded_bytes: stats.forwarded_bytes,
            rust_frames: stats.frames,
            rust_send_failed_frames: stats.send_failed_frames,
            rust_send_failed_bytes: stats.send_failed_bytes,
            rust_failed_flag: stats.failed,
            front_bytes: frontBytes,
            front_frames: frames,
            diff_front_vs_rust: frontBytes - stats.forwarded_bytes,
            // 完整跑才有意义：文件字节数之外的 shell 回显 + PTY ONLCR 展开开销
            overhead_vs_file: endedBy === "completed" ? frontBytes - BIG_FILE_BYTES : null,
          }
        : null;

      // --- Step 3: 三方账目 + 耗时 + 冻结计数回传报告 ---
      const report = {
        mode: "throughput",
        ended_by: endedBy,
        meta: {
          file: BIG_FILE,
          file_bytes: BIG_FILE_BYTES,
          interrupt,
          ua: navigator.userAgent,
          measured_at: new Date().toISOString(),
        },
        transfer: {
          elapsed_ms: +elapsedMs.toFixed(1),
          data_ms: +dataMs.toFixed(1),
          mib_per_s: +((rateBytes / 1048576) / (dataMs / 1000)).toFixed(2),
          mb_per_s: +((rateBytes / 1e6) / (dataMs / 1000)).toFixed(2),
          max_ipc_lag_bytes: maxLagBytes,
          lag_trace_2s: lagTrace,
        },
        freeze: {
          threshold_ms: FREEZE_GAP_MS,
          freezes,
          raf_suspended_gt_5s: rafSuspended,
          max_frame_gap_ms: +maxGapMs.toFixed(1),
          raf_frames: rafFrames,
        },
        account,
        channel: {
          typeof_first: firstType,
          base64_seen: base64Seen,
          frame_sizes: summarizeSizes(frameSizes),
        },
        interrupt: interruptInfo,
      };
      try {
        const path = await invoke<string>("spike_report_latency", {
          payload: JSON.stringify(report),
        });
        stage(`report written: ${path}`);
        const mbps = report.transfer.mib_per_s;
        setBadge(`${endedBy} | ${mbps} MiB/s | 冻结 ${freezes} | report=${path}`);
        term.writeln(
          `\r\n[spike] ${endedBy}: ${mbps} MiB/s 冻结=${freezes} report=${path}`,
        );
        clearWatchdog();
      } catch (e) {
        setBadge(`report 上报失败: ${e}`);
        stage(`report 上报失败: ${e}`);
      }
    })();
  }, []);

  return (
    <div className="spike-root">
      <div className="spike-badge" id="spike-badge">
        {badge}
      </div>
      <div className="spike-term" ref={hostRef} />
    </div>
  );
}
