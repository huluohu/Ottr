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

/** Otty 头像（四时刻共用脸）：C2-F5 呆毛歪头同构——宽圆墨头 + 双耳 + 呆毛 +
 * 奶油宽吻 + 琥珀鼻 + 宽距豆豆眼（teal-300 瞳，歪头一高一低）+ 无辜下弯眉 +
 * w 嘴 + 双腮红（56px ≥ 48 层，表情全开）；配色 class 全走品牌保留色 token
 * （见 31-otty.css 色板段）。 */
function OttyFace({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      {/* 呆毛 */}
      <path d="M30.4 8.8 C 28.4 5.2 29.4 2.4 33 1.2 C 31 4.4 31.4 7.2 33.2 9.4 Z" className="otty-c-ink" />
      {/* 双耳 */}
      <circle cx="16.8" cy="15.2" r="4.8" className="otty-c-ink" />
      <circle cx="47.2" cy="15.2" r="4.8" className="otty-c-ink" />
      {/* 宽圆头 */}
      <path d="M 16.8 54 L 16.8 34.8 C 16.8 20.8 23.2 14.4 32 14.4 C 40.8 14.4 47.2 20.8 47.2 34.8 L 47.2 54 Z" className="otty-c-ink" />
      {/* 奶油宽吻 + 琥珀鼻 */}
      <rect x="21.2" y="35.6" width="21.6" height="7.2" rx="3.6" className="otty-c-cream" />
      <rect x="28" y="34.2" width="8" height="3.8" rx="1.9" className="otty-c-amber" />
      {/* 宽距豆豆眼（歪头一高一低）+ 无辜下弯眉 */}
      <circle cx="23.2" cy="29.2" r="2.3" className="otty-c-ink" />
      <circle cx="40.8" cy="28.2" r="2.3" className="otty-c-ink" />
      <circle cx="23.9" cy="29.9" r="0.9" className="otty-c-teal" />
      <circle cx="41.5" cy="28.9" r="0.9" className="otty-c-teal" />
      <path d="M 18.4 24 Q 23.2 21.6 28 24" stroke="#0F172A" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M 36 24 Q 40.8 21.6 45.6 24" stroke="#0F172A" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      {/* w 小嘴 */}
      <path d="M 28.4 45.8 Q 30 47.6 32 45.8 Q 34 47.6 35.6 45.8" stroke="#0F172A" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      {/* 双腮红 */}
      <ellipse cx="19.6" cy="40.4" rx="3.4" ry="1.9" className="otty-c-blush" />
      <ellipse cx="44.4" cy="40.4" rx="3.4" ry="1.9" className="otty-c-blush" />
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
            <rect x="7.4" y="3.4" width="7.2" height="15.2" rx="3.6" className="otty-c-ink" />
            <ellipse cx="11" cy="6.6" rx="5" ry="3.2" className="otty-c-ink" />
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
