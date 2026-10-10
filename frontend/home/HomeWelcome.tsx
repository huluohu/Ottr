// 首页欢迎面（2026-10-10 壳层重构）：零会话空态从占位文字升级为
// 时段问候（Ottr 自己的文案）+ 快捷卡（新建主机/快速连接/导入配置/条件夹具
// 直连）+ 最近连接（标签持久化顺序 = 最近打开语义，见 session/retry.ts）。
// testid 兼容既有断言：main-empty / main-empty-actions / empty-add-host /
// empty-palette-hint / empty-connect-fixture 原样保留。
import { useTranslation } from "react-i18next";
import type { Host } from "../vault/api";
import { loadOpenTabIds } from "../session/retry";

export interface HomeWelcomeProps {
  hosts: Host[];
  fixtureHost: Host | null;
  onAddHost?: () => void;
  onOpenPalette?: () => void;
  onOpenImport?: () => void;
  onConnect: (host: Host) => void;
  /** ⌘K 键位标签（平台相关，MainArea 按 registry 换算后传入）。 */
  paletteLabel?: string;
  /** 问候基准时间（测试注入；缺省当前时间）。 */
  now?: Date;
}

/** 时段问候键（纯函数便于测试）：<5 深夜按晚间、5-12 早、12-18 午、其余晚。 */
export function greetingKey(hour: number): "morning" | "afternoon" | "evening" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

export function HomeWelcome({
  hosts,
  fixtureHost,
  onAddHost,
  onOpenPalette,
  onOpenImport,
  onConnect,
  paletteLabel,
  now,
}: HomeWelcomeProps) {
  const { t } = useTranslation();
  const hour = (now ?? new Date()).getHours();
  const greeting = t(`home.greeting.${greetingKey(hour)}`);
  // 最近连接 = 打开过的标签（持久化顺序即最近打开语义），去重取前 5。
  const recent = loadOpenTabIds()
    .map((id) => hosts.find((h) => h.id === id))
    .filter((h): h is Host => Boolean(h))
    .slice(0, 5);

  return (
    <>
      <img className="home-brand" src="/icon.svg" alt="" aria-hidden="true" />
      <h2 className="home-greeting" data-testid="home-greeting">
        {greeting}
      </h2>
      <p className="home-tagline">{t("home.tagline")}</p>
      {(fixtureHost || onAddHost || onOpenPalette || onOpenImport) && (
        <div className="main-empty-actions" data-testid="main-empty-actions">
          {fixtureHost && (
            <button
              type="button"
              className="main-empty-card"
              data-testid="empty-connect-fixture"
              onClick={() => onConnect(fixtureHost)}
            >
              <span className="main-empty-card-title">
                {t("mainArea.quickFixture", { name: fixtureHost.name })}
              </span>
              <span className="main-empty-card-desc">
                {fixtureHost.username ? `${fixtureHost.username}@` : ""}
                {fixtureHost.address}:{fixtureHost.port}
              </span>
            </button>
          )}
          {onAddHost && (
            <button type="button" className="main-empty-card" data-testid="empty-add-host" onClick={onAddHost}>
              <span className="main-empty-card-title">{t("mainArea.quickAddHost")}</span>
              <span className="main-empty-card-desc">{t("mainArea.quickAddHostDesc")}</span>
            </button>
          )}
          {onOpenPalette && (
            <button
              type="button"
              className="main-empty-card"
              data-testid="empty-palette-hint"
              onClick={onOpenPalette}
            >
              <span className="main-empty-card-title">
                {t("mainArea.quickPalette")}
                <kbd className="main-empty-kbd">{paletteLabel ?? "⌘K"}</kbd>
              </span>
              <span className="main-empty-card-desc">{t("mainArea.quickPaletteDesc")}</span>
            </button>
          )}
          {onOpenImport && (
            <button type="button" className="main-empty-card" data-testid="empty-import" onClick={onOpenImport}>
              <span className="main-empty-card-title">{t("mainArea.quickImport")}</span>
              <span className="main-empty-card-desc">{t("mainArea.quickImportDesc")}</span>
            </button>
          )}
        </div>
      )}
      {recent.length > 0 && (
        <div className="home-recent" data-testid="home-recent">
          <p className="home-recent-title">{t("home.recent")}</p>
          <ul className="home-recent-list">
            {recent.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  className="home-recent-item"
                  data-testid={`home-recent-${h.id}`}
                  onClick={() => onConnect(h)}
                >
                  <span className="home-recent-name">{h.name}</span>
                  <span className="home-recent-meta">
                    {h.username ? `${h.username}@` : ""}
                    {h.address}:{h.port}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
