// HostKeyDialog（Task 7，A6）：TOFU 主机密钥确认框。
// kind=first/pending →「信任并连接」为主操作（accent）；
// kind=changed  → 强提醒：默认操作是「拒绝连接」（accent），显式接受按钮红色
// （仍要连接）——用户显式点击才连（Rust 侧同约定：超时=拒绝）。
// 指纹整体展示 + 等宽字体（核对场景，不截断）。
import { useTranslation } from "react-i18next";
import { useEscClose } from "../ui/useEscClose";
import { useDelayedValue } from "../ui/useDelayedUnmount";
import { useModalStore } from "../ui/modalStore";
import { useSessionStore } from "./SessionStore";

export function HostKeyDialog() {
  const { t } = useTranslation();
  const ask = useSessionStore((s) => s.hostKeyAsk);
  const decide = useSessionStore((s) => s.decideHostKey);
  // 全局弹窗唯一槽（2026-10-14）：问询置起即认领（SessionStore），持有槽位
  // 才渲染；被其他弹窗顶掉 = 本框销毁——问询留在 SessionStore，Rust 门 60s
  // 超时按拒绝收尾（安全侧），不自动重回。
  const owned = useModalStore((s) => s.active === "hostKey");
  // Esc = 拒绝连接（与 Rust 侧超时=拒绝同口径；changed 强提醒下 Esc 不可能
  // 误连——拒绝是两种形态的共同安全侧）。
  useEscClose(ask != null && owned, () => {
    void decide(false);
  });
  // 退场动画窗（评审 P1-8）：ask 清空后保留挂载播镜像动画，再真卸载。
  // 渲染门 `|| (view.closing && 槽位空闲)`：正常裁定播退场；被顶掉立即销毁。
  const view = useDelayedValue(ask);
  const slotIdle = useModalStore((s) => s.active === null);
  if (!view.value || !(owned || (view.closing && slotIdle))) return null;
  const ask0 = view.value;
  const changed = ask0.kind === "changed";
  return (
    <div className={`overlay${view.closing ? " closing" : ""}`} data-testid="host-key-dialog">
      <div className="dialog host-key" role="alertdialog" aria-modal="true">
        <h2 className={changed ? "host-key-changed-title" : undefined}>
          {changed ? t("hostKey.changedTitle") : t("hostKey.firstTitle")}
        </h2>
        {/* 跳板链逐跳问询（Phase 2 Task 2）：带「第 N 跳」标识（hop 0 起计，
            展示用 1 起的人类序号——与断点定位文案同源语义）。 */}
        {ask0.hop != null && (
          <p className="host-key-hop" data-testid="host-key-hop">
            {t("hostKey.hopLabel", { hop: ask0.hop + 1 })}
          </p>
        )}
        <p className="dialog-intro">
          {ask0.kind === "pending"
            ? t("hostKey.pendingIntro", { host: ask0.host_name })
            : changed
              ? t("hostKey.changedIntro", { host: ask0.host_name })
              : t("hostKey.firstIntro", { host: ask0.host_name })}
        </p>
        <p className="host-key-fp">
          <span className="host-key-fp-label">{t("hostKey.fingerprint")}</span>
          <code data-testid="host-key-fingerprint">{ask0.fingerprint}</code>
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
