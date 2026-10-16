// 涟漪反馈单测（jsdom）：坐标写入 + 类重放 + 目标外不触发。
import { describe, expect, it } from "vitest";
import { initRipple } from "./ripple";

function pointerDownAt(el: Element, x = 10, y = 6): void {
  const event = new MouseEvent("pointerdown", {
    bubbles: true,
    clientX: x,
    clientY: y,
  });
  el.dispatchEvent(event);
}

describe("涟漪反馈（initRipple）", () => {
  it("命中 .btn-accent：写触点坐标变量并挂 .rippling", () => {
    const dispose = initRipple();
    try {
      const btn = document.createElement("button");
      btn.className = "btn-accent";
      document.body.appendChild(btn);
      pointerDownAt(btn, 12, 8);
      expect(btn.classList.contains("rippling")).toBe(true);
      expect(btn.style.getPropertyValue("--ripple-x")).toBe("12px");
      expect(btn.style.getPropertyValue("--ripple-y")).toBe("8px");
    } finally {
      dispose();
    }
  });

  it("命中 .host-row / .sidebar-flyout button（后代冒泡命中最近目标）", () => {
    const dispose = initRipple();
    try {
      const row = document.createElement("div");
      row.className = "host-row";
      const inner = document.createElement("span");
      row.appendChild(inner);
      document.body.appendChild(row);
      pointerDownAt(inner);
      expect(row.classList.contains("rippling")).toBe(true);

      const flyBtn = document.createElement("button");
      const fly = document.createElement("div");
      fly.className = "sidebar-flyout";
      fly.appendChild(flyBtn);
      document.body.appendChild(fly);
      pointerDownAt(flyBtn);
      expect(flyBtn.classList.contains("rippling")).toBe(true);
    } finally {
      dispose();
    }
  });

  it("目标外元素不触发；重复按压重放（类先卸后挂）", () => {
    const dispose = initRipple();
    try {
      const plain = document.createElement("button");
      document.body.appendChild(plain);
      pointerDownAt(plain);
      expect(plain.classList.contains("rippling")).toBe(false);

      const btn = document.createElement("button");
      btn.className = "btn-accent";
      document.body.appendChild(btn);
      pointerDownAt(btn);
      expect(btn.classList.contains("rippling")).toBe(true);
      pointerDownAt(btn);
      expect(btn.classList.contains("rippling")).toBe(true);
    } finally {
      dispose();
    }
  });

  it("dispose 后不再监听", () => {
    const dispose = initRipple();
    dispose();
    const btn = document.createElement("button");
    btn.className = "btn-accent";
    document.body.appendChild(btn);
    pointerDownAt(btn);
    expect(btn.classList.contains("rippling")).toBe(false);
  });
});
