// Otty 情感时刻（2026-10-16 视觉重设计 M3「疏渠」，报告 §5 提案 3 + 图 7）：
// 四个标志性瞬间，SVG + CSS token 实现（31-otty.css），配色走品牌保留色
// token（LockOtter 同纪律：毛色 --ottr-fur-600、吻部 --ottr-cream-100、墨色
// --ottr-ink-900、Amber 点缀 --ottr-amber-500、瞳 --ottr-teal-300）。
// App 挂载一次，本组件持有三个触发订阅（更新就绪在 updateToasts 直派 play）：
//   connect  —— 已连接会话计数翻升（订阅 SessionStore）
//   transfer —— 传输收尾 status=done 计数翻升（订阅 TransferStore）
//   unlock   —— 锁定状态机 locked→unlocked（订阅 VaultLockStore）
// 渲染 = fixed 覆盖层（pointer-events:none，不挡交互），z 同 toast 层、
// 声明在后 painter 胜出；到点由 ottyStore.finish 出队（OTTY_MOMENT_MS）。
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../../session/SessionStore";
import { useTransferStore } from "../../files/TransferStore";
import { useVaultLockStore } from "../../security/VaultLockStore";
import { OTTY_MOMENT_MS, useOttyStore, type OttyMoment } from "./ottyStore";

/** Otty 头像（四时刻共用脸）：v5 同构——墨头 + 奶油脸盘 + 豆豆眼（teal-300
 * 瞳）+ 琥珀鼻；配色 class 全走品牌保留色 token（见 31-otty.css 色板段）。 */
function OttyFace({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="34" r="26" className="otty-c-ink" />
      <circle cx="47" cy="13" r="5" className="otty-c-ink" />
      <circle cx="47" cy="13" r="2.3" className="otty-c-fur" />
      <ellipse cx="30" cy="40" rx="17" ry="15" className="otty-c-cream" />
      <path
        d="M19.5 28.5 C 19.5 26 21.7 24.8 23.5 25.8 C 24.5 26.4 25.5 26.4 26.5 25.8 C 28.3 24.8 30.5 26 30.5 28.5 C 30.5 31.7 28.1 34 25 34 C 21.9 34 19.5 31.7 19.5 28.5 Z"
        className="otty-c-amber"
      />
      <ellipse cx="19" cy="38.5" rx="3" ry="3.6" className="otty-c-ink" />
      <ellipse cx="37.5" cy="37.3" rx="3" ry="3.6" className="otty-c-ink" />
      <circle cx="18" cy="37.1" r="1.1" className="otty-c-teal" />
      <circle cx="36.5" cy="35.9" r="1.1" className="otty-c-teal" />
    </svg>
  );
}

/** 时刻 → 挂载点 + 动画场景。 */
function MomentScene({ moment }: { moment: OttyMoment }) {
  const { t } = useTranslation();
  if (moment === "connect") {
    // 连接成功：终端右下角探头划水——外层滑入滑出（otty-peek），内层随波
    // 摇摆（--dur-loop-idle 循环），爪子高举打招呼，一枚 Amber 星点点缀。
    return (
      <div className="otty-scene otty-connect">
        <div className="otty-bob">
          <OttyFace />
          <svg className="otty-paw" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <ellipse cx="11" cy="11" rx="8" ry="6.5" className="otty-c-ink" />
            <ellipse cx="11" cy="9" rx="4.5" ry="3" className="otty-c-cream" />
          </svg>
          <svg className="otty-spark" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2.5 L14.4 9 L21.5 9.6 L16 14.1 L17.8 21 L12 17.2 L6.2 21 L8 14.1 L2.5 9.6 L9.6 9 Z"
              className="otty-c-amber"
            />
          </svg>
        </div>
        <span className="otty-caption">{t("otty.connect")}</span>
      </div>
    );
  }
  if (moment === "transfer") {
    // 传输完成：星光沿屏幕底沿（进度条隐喻的水面）左→右滑行，Amber 光晕
    // 尾巴（box-shadow，见 CSS）。
    return (
      <div className="otty-scene otty-transfer" aria-hidden>
        <svg className="otty-star" width="26" height="26" viewBox="0 0 24 24">
          <path
            d="M12 2.5 L14.4 9 L21.5 9.6 L16 14.1 L17.8 21 L12 17.2 L6.2 21 L8 14.1 L2.5 9.6 L9.6 9 Z"
            className="otty-c-amber"
          />
        </svg>
      </div>
    );
  }
  if (moment === "unlock") {
    // 解锁成功：草叶从顶沿飘落收尾（接锁屏彩蛋的草叶 DNA），Otty 在屏角
    // 仰头接住（淡入淡出）。
    return (
      <div className="otty-scene otty-unlock" aria-hidden>
        <svg className="otty-leaf" width="30" height="30" viewBox="0 0 30 30">
          <path d="M15 27 C 6 20 5 9 14 3 C 24 8 25 20 15 27 Z" className="otty-c-leaf" />
          <path
            d="M15 27 C 15 19 14.5 12 14 5"
            stroke="var(--color-success)"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
        <div className="otty-unlock-face otty-bob">
          <OttyFace size={44} />
        </div>
      </div>
    );
  }
  // 更新就绪：冲浪板沿屏幕顶沿滑过——「乘着新版本破浪」（Amber 板身）。
  return (
    <div className="otty-scene otty-update" aria-hidden>
      <div className="otty-surf-bob">
        <OttyFace size={40} />
        <svg className="otty-board" width="52" height="18" viewBox="0 0 52 18">
          <path d="M3 12 C 14 4 38 4 49 12 C 38 15.5 14 15.5 3 12 Z" className="otty-c-amber" />
          <path
            d="M8 12.8 C 18 7.5 34 7.5 44 12.8"
            stroke="var(--ottr-amber-500)"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            opacity="0.6"
          />
        </svg>
      </div>
    </div>
  );
}

export function OttyMoments() {
  const current = useOttyStore((s) => s.current);
  const finish = useOttyStore((s) => s.finish);

  // 到点出队（单时刻在场时长恒定；队列由 finish 自动接续）。
  useEffect(() => {
    if (current === null) return;
    const timer = window.setTimeout(finish, OTTY_MOMENT_MS);
    return () => window.clearTimeout(timer);
  }, [current, finish]);

  // 触发订阅×3（见头注；更新就绪在 updateToasts 直派）。
  useEffect(() => {
    let prevConnected = countConnected();
    const offSession = useSessionStore.subscribe((s) => {
      const n = countConnected(s);
      if (n > prevConnected) useOttyStore.getState().play("connect");
      prevConnected = n;
    });
    let prevTransferDone = countTransferDone();
    const offTransfer = useTransferStore.subscribe((s) => {
      const n = countTransferDone(s);
      if (n > prevTransferDone) useOttyStore.getState().play("transfer");
      prevTransferDone = n;
    });
    let prevLocked = useVaultLockStore.getState().phase === "locked";
    const offLock = useVaultLockStore.subscribe((s) => {
      const locked = s.phase === "locked";
      if (prevLocked && !locked) useOttyStore.getState().play("unlock");
      prevLocked = locked;
    });
    return () => {
      offSession();
      offTransfer();
      offLock();
    };
  }, []);

  if (current === null) return null;
  return (
    <div className="otty-layer" data-testid="otty-layer" data-moment={current} aria-live="polite">
      <MomentScene moment={current} />
    </div>
  );
}

function countConnected(s?: ReturnType<typeof useSessionStore.getState>): number {
  const state = s ?? useSessionStore.getState();
  return state.sessions.filter((x) => x.status === "connected").length;
}

function countTransferDone(s?: ReturnType<typeof useTransferStore.getState>): number {
  const state = s ?? useTransferStore.getState();
  return state.items.filter((x) => x.status === "done").length;
}
