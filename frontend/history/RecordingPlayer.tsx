// RecordingPlayer（Phase 3 Task 5，B3）：录制回放对话框——xterm 只读实例 +
// 时间轴拖动（seek = asciinema 事件定位）+ 倍速（0.5/1/2/4）+ 导出分享。
//
// 结构：调度核在 playback.ts（纯逻辑，vitest 精确断言）；本组件只做渲染与
// 接线——50ms interval 驱动 tick，tick 产出的数据块 term.write；后跳 seek 先
// term.reset() 再整段重放（官方播放器同款语义）。
//
// 导出纪律（简报裁定 #3）：默认「导出（脱敏）」经 T13 redact 引擎（默认规则
// 表，含自定义规则）；「导出原文」是两段式确认按钮（第一次点击变确认态，
// 3s 无操作自动还原）——敏感内容显式动作才出门。路径经 plugin-dialog save
// （Tauri 才有；缺省交 Rust 落下载目录）。xterm 尺寸取录制 header（只读回放，
// 不接 fit——回放窗口尺寸失配由 xterm 滚动兜底，避免为打磨引入 resize 语义）。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { showToast } from "../ui/toastStore";
import { Terminal as XTerm } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import type { RecordingData } from "../vault/api";
import { redact, type RedactRule } from "../ai/redact";
import { PlaybackController, PLAYBACK_SPEEDS, formatPlaybackTime } from "./playback";
import { useEscClose } from "../ui/useEscClose";

/** 驱动节拍（ms）——20fps 对终端回放足够顺滑，interval 开销可忽略。 */
const TICK_MS = 50;
/** 导出原文确认态自动还原（ms）。 */
const RAW_CONFIRM_RESET_MS = 3000;

export interface RecordingPlayerProps {
  data: RecordingData;
  onClose: () => void;
  /** 测试注入：省去 plugin-dialog 动态导入（jsdom 无 Tauri）。 */
  savePath?: (suggestedName: string) => Promise<string | null>;
}

/** 事件流导出体（脱敏或原文，逐事件过 redact——转义序列不被默认规则吞）。 */
export function assembleExportEvents(
  data: RecordingData,
  mode: "redacted" | "raw",
  custom?: RedactRule[],
): { time: number; data: string }[] {
  if (mode === "raw") {
    return data.events.map((e) => ({ time: e.time, data: e.data }));
  }
  return data.events.map((e) => ({
    time: e.time,
    data: redact(e.data, { custom }).text,
  }));
}

export function RecordingPlayer({ data, onClose, savePath }: RecordingPlayerProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const controllerRef = useRef<PlaybackController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [speed, setSpeed] = useState<(typeof PLAYBACK_SPEEDS)[number]>(1);
  const [rawConfirm, setRawConfirm] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const { entry, header, duration } = data;

  // 回放实例挂载（一次性）：只读（disableStdin）、header 尺寸、回放前先写
  // [0, 0]（时间 0 的事件已随初始 render 到位——controller 从 0 起步由驱动写）。
  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      cols: header.width,
      rows: header.height,
      disableStdin: true,
      convertEol: false,
      allowProposedApi: true,
    });
    term.open(hostRef.current);
    termRef.current = term;
    const c = new PlaybackController(data.events);
    controllerRef.current = c;
    // 时间 0 的事件（录制首提示符等）随打开即写（t<=0 与「播放头在 0」同域）
    const { chunks } = c.seek(0);
    if (chunks.length > 0) term.write(chunks.join(""));
    return () => {
      term.dispose();
      termRef.current = null;
      controllerRef.current = null;
    };
    // data 以引用稳定使用（面板打开期间不换录制——换录制走重挂 key）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 驱动循环：playing 时 50ms 一拍；末尾自动停（不循环）。
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const c = controllerRef.current;
      if (!c) return;
      const chunks = c.tick(TICK_MS / 1000);
      const term = termRef.current;
      if (term && chunks.length > 0) {
        term.write(chunks.join(""));
      }
      setPos(c.pos);
      if (c.ended) setPlaying(false);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const c = controllerRef.current;
    const term = termRef.current;
    if (!c || !term) return;
    const { forward, chunks } = c.seek(Number(e.currentTarget.value));
    if (forward) {
      if (chunks.length > 0) term.write(chunks.join(""));
    } else {
      term.reset();
      if (chunks.length > 0) term.write(chunks.join(""));
    }
    setPos(c.pos);
    setPlaying(false);
  }

  function togglePlay() {
    const c = controllerRef.current;
    if (!c) return;
    if (!playing && c.ended) {
      // 结束后再播 = 从头（后跳 seek 语义）
      const { chunks } = c.seek(0);
      termRef.current?.reset();
      if (chunks.length > 0) termRef.current?.write(chunks.join(""));
      setPos(0);
    }
    setPlaying((v) => !v);
  }

  async function doExport(mode: "redacted" | "raw") {
    try {
      const events = assembleExportEvents(data, mode);
      const suggested = `ottr-recording-${entry.id}.cast`;
      let path: string | null = null;
      if (savePath) {
        path = await savePath(suggested);
      } else {
        try {
          const { save } = await import("@tauri-apps/plugin-dialog");
          path = await save({ defaultPath: suggested });
        } catch {
          path = null; // 非 Tauri 环境：无对话框即中止（安全侧）
        }
      }
      // fix round 1/5 M-3：save() 返回 null = 用户取消 → **中止导出**，绝不
      // 落默认名（原文导出场景防「顺手确认」写出未脱敏文件到下载目录）。
      if (path === null) {
        setExportMsg(t("recording.exportCancelled"));
        return;
      }
      const written = await invoke<string>("recording_export", {
        id: entry.id,
        events,
        path,
      });
      setExportMsg(written);
      showToast(written, "info");
    } catch (e) {
      const msg = String(e);
      setExportMsg(msg);
      showToast(msg, "error");
    }
  }

  // 原文确认态自动还原
  useEffect(() => {
    if (!rawConfirm) return;
    const timer = window.setTimeout(() => setRawConfirm(false), RAW_CONFIRM_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [rawConfirm]);

  // Esc 关闭回放：走全局 Esc 栈（回放器后于 ⌘R 面板入栈 = 栈顶）——
  // 「先关回放、面板仍在」由栈序保证，不再需要 capture 硬拦冒泡。
  useEscClose(true, onClose);

  const created = useMemo(
    () => new Date(entry.created_at * 1000).toLocaleString(),
    [entry.created_at],
  );

  return (
    <div className="palette-overlay player-overlay" data-testid="recording-player" onMouseDown={onClose}>
      <div
        className="dialog recording-player"
        role="dialog"
        aria-modal="true"
        aria-label={t("recording.playerTitle")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="recording-player-head">
          <span className="recording-player-title">
            {t("recording.playerTitle", { id: entry.id })}
          </span>
          <span className="recording-player-meta">
            {header.width}×{header.height} · {created}
          </span>
          <button
            type="button"
            className="recording-player-close"
            data-testid="player-close"
            aria-label={t("recording.close")}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="recording-player-term" ref={hostRef} data-testid="player-term" />
        <div className="recording-player-controls">
          <button
            type="button"
            className="recording-player-play"
            data-testid="player-play"
            aria-label={t(playing ? "recording.pause" : "recording.play")}
            onClick={togglePlay}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <span className="recording-player-time" data-testid="player-time">
            {formatPlaybackTime(pos)}
          </span>
          <input
            type="range"
            className="recording-player-seek"
            data-testid="player-seek"
            min={0}
            max={duration}
            step={0.01}
            value={pos}
            aria-label={t("recording.timeline")}
            onChange={onSeek}
          />
          <span className="recording-player-time">{formatPlaybackTime(duration)}</span>
          <div className="recording-player-speeds" role="group" aria-label={t("recording.speed")}>
            {PLAYBACK_SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                data-active={speed === s}
                data-testid={`player-speed-${s}`}
                onClick={() => {
                  setSpeed(s);
                  controllerRef.current?.setSpeed(s);
                }}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
        <div className="recording-player-actions">
          <button
            type="button"
            className="btn-accent"
            data-testid="player-export-redacted"
            onClick={() => void doExport("redacted")}
          >
            {t("recording.exportRedacted")}
          </button>
          <button
            type="button"
            className={rawConfirm ? "btn-danger" : ""}
            data-testid="player-export-raw"
            onClick={() => {
              if (rawConfirm) {
                setRawConfirm(false);
                void doExport("raw");
              } else {
                setRawConfirm(true);
              }
            }}
          >
            {rawConfirm ? t("recording.exportRawConfirm") : t("recording.exportRaw")}
          </button>
          {exportMsg && (
            <span className="recording-player-exportmsg" data-testid="player-export-msg">
              {exportMsg}
            </span>
          )}
        </div>
        <p className="recording-player-hint">{t("recording.exportHint")}</p>
      </div>
    </div>
  );
}
