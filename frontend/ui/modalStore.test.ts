// modalStore 单测：全局弹窗唯一槽的核心裁定（2026-10-14 用户口径「同时只能
// 有一个弹框，新弹框显示，其他弹框先要销毁」）——open 顶掉当前、close 仅清
// 自己的槽。防漂移：任何「允许多弹窗并存」的回归都在这里红。
import { beforeEach, describe, expect, it } from "vitest";
import { useModalStore } from "./modalStore";

describe("modalStore 全局弹窗唯一槽", () => {
  beforeEach(() => {
    useModalStore.setState({ active: null });
  });

  it("open 占槽；异值 open 直接顶掉当前弹窗（销毁语义）", () => {
    useModalStore.getState().open("settings");
    expect(useModalStore.getState().active).toBe("settings");
    // 设置开着时 ⌘K 到来：不排队不叠层，槽位直接换主
    useModalStore.getState().open("palette");
    expect(useModalStore.getState().active).toBe("palette");
    useModalStore.getState().open("hostKey");
    expect(useModalStore.getState().active).toBe("hostKey");
  });

  it("close 仅在 id 仍持槽时清空——被顶掉的旧弹窗迟滞关闭不误伤新弹窗", () => {
    useModalStore.getState().open("settings");
    useModalStore.getState().open("palette");
    // settings 的迟滞 onClose 此刻到达：不得关掉 palette
    useModalStore.getState().close("settings");
    expect(useModalStore.getState().active).toBe("palette");
    // 自己的槽自己能关
    useModalStore.getState().close("palette");
    expect(useModalStore.getState().active).toBeNull();
  });

  it("close 幂等：空槽/异者 close 均 no-op", () => {
    expect(useModalStore.getState().active).toBeNull();
    useModalStore.getState().close("history");
    expect(useModalStore.getState().active).toBeNull();
    useModalStore.getState().open("history");
    useModalStore.getState().close("history");
    useModalStore.getState().close("history");
    expect(useModalStore.getState().active).toBeNull();
  });
});
