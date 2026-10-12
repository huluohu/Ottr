// TEMP：UI 验证驱动器（仅 DEV 生效，验证后删除）。
let lastV = -1;
async function poll(): Promise<void> {
  try {
    const res = await fetch(`/__ui-cmd.json?v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const cmd = (await res.json()) as { v: number; action: string; arg?: string };
    if (cmd.v === lastV) return;
    lastV = cmd.v;
    const fire = (el: Element | null | undefined, type: string, key?: string) => {
      if (!el) return;
      el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
    };
    if (cmd.action === "open-palette") {
      document.querySelector<HTMLElement>('[data-testid="sidebar-search"]')?.click();
    } else if (cmd.action === "key") {
      // 故意派发到 body：验证导航不再依赖输入框焦点
      fire(document.body, "keydown", cmd.arg);
    } else if (cmd.action === "enter") {
      fire(document.body, "keydown", "Enter");
    }
  } catch { /* 静默 */ }
}
if (import.meta.env.DEV) window.setInterval(poll, 400);
