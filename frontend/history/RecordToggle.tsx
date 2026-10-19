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
import { showToast } from "../ui/toastStore";
import { revealLocalFile } from "../files/api";

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

/** 任一会话在录（2026-10-18 用户裁定）：录制钮属会话域，库级页签（通知中心/
 * 定时任务等）不再常驻——但「正在录」时保留指示+停止入口（录制是敏感面，
 * 走着悄无声息比多显示一颗红点更糟）。 */
export function useAnyRecording(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return recordingIds.size > 0;
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
        const stop = (await invoke("recording_stop", { rustId })) as {
          saved_path?: string | null;
        };
        recordingIds.delete(rustId);
        if (stop.saved_path) {
          // 「点击到达文件所在目录」（2026-10-19 用户需求）：toast 内直接
          // 提供操作按钮，点它在系统文件管理器中定位 .cast 原档。
          const savedPath = stop.saved_path;
          showToast(
            t("recording.saved", { path: savedPath }),
            "info",
            {
              label: t("recording.revealDir"),
              run: () => {
                void revealLocalFile(savedPath).catch((e) =>
                  showToast(t("recording.revealFailed", { message: String(e) }), "error"),
                );
              },
            },
            15000,
          );
        }
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
