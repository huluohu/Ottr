// MainViewSlot（UI 批次一 Task 2）：overview/batch 主区槽位占位组件。
// 本任务只立骨架（标题 + 返回终端 + 占位提示）；T3 把 OverviewPage/BatchPanel
// 实体迁入本槽（届时本组件消亡，导航语义由实体自带的 onOpen → 终端标签承接）。
import { useTranslation } from "react-i18next";
import { useWorkspaceStore } from "./workspaceStore";
import type { MainView } from "./types";

/** 视图 → 标题 i18n 键（复用既有键，零新增文案）。 */
const SLOT_TITLE_KEY: Record<"overview" | "batch", string> = {
  overview: "overview.title",
  batch: "batch.title",
};

export function MainViewSlot({ view }: { view: Extract<MainView, "overview" | "batch"> }) {
  const { t } = useTranslation();
  const openMainView = useWorkspaceStore((s) => s.openMainView);
  return (
    <section className="main-view-slot" data-testid="main-view-slot" data-view={view}>
      <div className="main-view-slot-head">
        <h2>{t(SLOT_TITLE_KEY[view])}</h2>
        {/* 返回终端 = mainView 状态机回默认视图（会话与终端缓冲从未卸载） */}
        <button data-testid="slot-back-terminal" onClick={() => openMainView("terminal")}>
          ← {t("files.viewTerminal")}
        </button>
      </div>
      <p className="main-view-slot-hint">{t("workspace.slotHint")}</p>
    </section>
  );
}
