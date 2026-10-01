// HostKeyDialog（Task 7，A6）：TOFU 主机密钥确认框。
// kind=first/pending →「信任并连接」为主操作（accent）；
// kind=changed  → 强提醒：默认操作是「拒绝连接」（accent），显式接受按钮红色
// （仍要连接）——用户显式点击才连（Rust 侧同约定：超时=拒绝）。
// 指纹整体展示 + 等宽字体（核对场景，不截断）。
import { useTranslation } from "react-i18next";
import { useSessionStore } from "./SessionStore";

export function HostKeyDialog() {
  const { t } = useTranslation();
  const ask = useSessionStore((s) => s.hostKeyAsk);
  const decide = useSessionStore((s) => s.decideHostKey);
  if (!ask) return null;
  const changed = ask.kind === "changed";
  return (
    <div className="overlay" data-testid="host-key-dialog">
      <div className="dialog host-key" role="alertdialog" aria-modal="true">
        <h2 className={changed ? "host-key-changed-title" : undefined}>
          {changed ? t("hostKey.changedTitle") : t("hostKey.firstTitle")}
        </h2>
        {/* 跳板链逐跳问询（Phase 2 Task 2）：带「第 N 跳」标识（hop 0 起计，
            展示用 1 起的人类序号——与断点定位文案同源语义）。 */}
        {ask.hop != null && (
          <p className="host-key-hop" data-testid="host-key-hop">
            {t("hostKey.hopLabel", { hop: ask.hop + 1 })}
          </p>
        )}
        <p className="dialog-intro">
          {ask.kind === "pending"
            ? t("hostKey.pendingIntro", { host: ask.host_name })
            : changed
              ? t("hostKey.changedIntro", { host: ask.host_name })
              : t("hostKey.firstIntro", { host: ask.host_name })}
        </p>
        <p className="host-key-fp">
          <span className="host-key-fp-label">{t("hostKey.fingerprint")}</span>
          <code data-testid="host-key-fingerprint">{ask.fingerprint}</code>
        </p>
        {changed && <p className="host-key-warning">{t("hostKey.changedWarning")}</p>}
        <div className="form-actions">
          <button
            data-testid="host-key-reject"
            className={changed ? "btn-accent" : undefined}
            onClick={() => void decide(false)}
          >
            {t("hostKey.reject")}
          </button>
          <button
            data-testid="host-key-accept"
            className={changed ? "btn-danger" : "btn-accent"}
            onClick={() => void decide(true)}
          >
            {changed ? t("hostKey.acceptAnyway") : t("hostKey.trust")}
          </button>
        </div>
      </div>
    </div>
  );
}
