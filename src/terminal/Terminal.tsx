// Terminal.tsx（Task 4 产出，Task 5-10 复用）：
// xterm.js 前端 + `attach_session` 二进制通道（Raw → ArrayBuffer）+ `write_session` 击键写入。
//
// spike 模式（?spike=latency，由 OTTR_SPIKE=latency 自动导航进入）：
// 1. 先跑通道探针（Raw 16B / Raw 2KB / JSON-base64 对照，typeof+长度对账 → 定案证据）；
// 2. attach 后等 shell 稳定，`exec cat` 换成纯回显进程（无 prompt 噪声）；
// 3. 自动打 100 字符（间隔 20ms），performance.now() 记「发出 → term.write 收到回显」；
// 4. p50/p95 + 帧长对账 JSON POST 给 `spike_report_latency` 落盘 /tmp/ottr-latency.json
//    （取数机制：scripts/spike-latency.sh 轮询该文件后 kill dev server）。
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
