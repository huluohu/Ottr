// RecordingPanel（Phase 3 Task 5，B3）：⌘R 面板「录制」页签——录制审计回放的
// 检索面。消费 recording_search（FTS trigram / LIKE 兜底在 Rust 层分派，同
// history 检索语义；空 query = 最近录制）+ host 过滤；命中行 = 主机名 / 时长 /
// 时间 / 命中上下文窗口（snippet）。点击行 → recording_read 取 v2 解析结果 →
// RecordingPlayer 回放（面板内挂载，Esc 先关回放再关面板）。
//
// 【安全面】录制默认不自动开启（会话级开关在 Terminal 工具栏 RecordToggle）；
// 分享导出默认脱敏（T13 redact），入口在回放器内。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Host, RecordingData, RecordingHit } from "../vault/api";
import { vaultApi } from "../vault/api";
import { historyTime } from "./format";
import { RecordingPlayer } from "./RecordingPlayer";

export interface RecordingPanelProps {
  /** host 过滤（⌘R 面板共享的下拉值；null = 全部）。 */
  hostId: number | null;
  hosts: Host[];
  /** 面板打开/过滤变化时的查询词（防抖后的；空 = 最近录制）。 */
  query: string;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export function RecordingPanel({ hostId, hosts, query }: RecordingPanelProps) {
  const { t } = useTranslation();
  const [hits, setHits] = useState<RecordingHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState<RecordingData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void vaultApi.recordings
      .search(query, hostId, 50)
      .then((rows) => {
        if (alive) {
          setHits(Array.isArray(rows) ? rows : []);
          setError(null);
        }
      })
      .catch((e) => {
        // 检索失败（旧库迁移前/后端异常）：空结果 + 错误条，不阻塞面板
        if (alive) {
          setHits([]);
          setError(String(e));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [query, hostId]);

  async function openRecording(id: number) {
    setError(null);
    try {
      const data = await vaultApi.recordings.read(id);
      setPlaying(data);
    } catch (e) {
      setError(String(e));
    }
  }

  const hostName = (id: number): string =>
    hosts.find((h) => h.id === id)?.name ?? t("history.unknownHost");

  if (playing) {
    return <RecordingPlayer data={playing} onClose={() => setPlaying(null)} />;
  }

  return (
    <ul className="palette-list" data-testid="recording-list">
      {error && (
        <li className="palette-empty" data-testid="recording-error">
          {t("recording.searchError", { message: error })}
        </li>
      )}
      {hits.length === 0 && !error && (
        <li className="palette-empty">{loading ? t("recording.loading") : t("recording.empty")}</li>
      )}
      {hits.map((hit) => (
        <li key={hit.id}>
          <button
            className="palette-item history-item recording-item"
            data-testid="recording-item"
            onClick={() => void openRecording(hit.id)}
          >
            <span className="history-main">
              <span className="recording-main">
                <span className="recording-badge">▶</span>
                <span className="history-cmd" title={hit.snippet}>
                  {hit.snippet || t("recording.emptyContent")}
                </span>
              </span>
              <span className="history-meta">
                <span className="history-host">{hostName(hit.host_id)}</span>
                <span className="history-badge exit-none" data-testid="recording-duration">
                  {formatDuration(hit.duration)}
                </span>
                <span className="history-time">{historyTime(hit.created_at)}</span>
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
