// RecordToggle（Phase 3 Task 5，B3）：Terminal 工具栏的会话级录制开关。
//
// 【安全面裁定】录制含终端全量输出（敏感面），默认**不**自动开启——只有用户
// 显式点击才开始 tee；停止即入库（回放/检索立即可用）。断线时 Rust 侧转发
// 循环收尾自动 finalize 入库（审计痕迹不随连接死亡丢失）；前端按 rustId 挂
// 键，rustId 消失（重连中/已断开）按钮回 idle 禁用态——重连后是**新会话**，
// 旧录制的 tee 已随会话收尾落库，语义一致。
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

export interface RecordToggleProps {
  /** 当前 Rust 会话 id（null = 无活动连接 → 禁用）。 */
  rustId: string | null;
  hostId: number | null;
}

/** 录制中的会话表（rustId → true）。跨标签共享状态（TabBar/工具栏同源）。 */
const recordingIds = new Set<string>();
const listeners = new Set<() => void>();

function notifyAll() {
  for (const l of listeners) l();
}

function useIsRecording(rustId: string | null): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return rustId !== null && recordingIds.has(rustId);
}

export function RecordToggle({ rustId, hostId }: RecordToggleProps) {
  const { t } = useTranslation();
  const recording = useIsRecording(rustId);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (!rustId || hostId === null || busy) return;
    setBusy(true);
    try {
      if (recording) {
        await invoke("recording_stop", { rustId });
        recordingIds.delete(rustId);
      } else {
        await invoke("recording_start", { rustId, hostId });
        recordingIds.add(rustId);
      }
      notifyAll();
    } catch (e) {
      // 开关失败（会话刚断/已在录）：状态按当前面回正，错误不打断终端
      console.warn("[recording] toggle failed:", e);
    } finally {
      setBusy(false);
    }
  }

  // rustId 变化（重连/断开）：旧会话的录制已由 Rust 循环收尾 auto-finalize，
  // 本地标记随之清账（按钮回 idle）。
  const prevRustId = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRustId.current;
    prevRustId.current = rustId;
    if (prev !== null && prev !== rustId && recordingIds.delete(prev)) {
      notifyAll();
    }
  }, [rustId]);

  return (
    <button
      type="button"
      className="record-toggle"
      data-testid="record-toggle"
      data-active={recording}
      disabled={!rustId || hostId === null}
      aria-pressed={recording}
      title={
        recording ? t("recording.stopTitle") : t("recording.startTitle")
      }
      onClick={() => void toggle()}
    >
      <span className="record-toggle-dot" aria-hidden="true" />
      {t(recording ? "recording.stopLabel" : "recording.startLabel")}
    </button>
  );
}
