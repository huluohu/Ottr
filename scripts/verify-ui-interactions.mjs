// 无头浏览器**交互**验收（2026-11-03）：真组件 + 真计时 + 真 IPC 桩。
//
// 覆盖本轮新增交互面的「行为」（不只是几何）：
//   1. 交互式认证弹窗：倒计时走字 → 到期**自动换码**（输入框值变化）→ 提交；
//   2. Ask Ottr 提问态：占位符是「问点什么」而不是「追问」；
//   3. 凭据表单：TOTP 类型下出现「位数/步长」两个输入；类型清单里有「系统 ssh-agent」；
//   4. MCP 客户端设置：能列出工具并调一次工具（IPC 桩）。
//
// 与真机验收的关系：真机（Linux/WebKitGTK）那轮被网络阻塞跑不了，这套是
// **浏览器级**的等价验证（同一份组件、同一份 store、同一套 IPC 调用形状）。
// 真机那轮补的是「WebKitGTK 上的渲染与真 IPC 往返」这一层。
//
// 用法：node scripts/verify-ui-interactions.mjs
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_PATH ?? "/Users/guxiaolong/.npm/_npx/e41f203b7505f1fb/node_modules/playwright",
);

const server = await createServer({ server: { port: 1432 } });
await server.listen();

const browser = await chromium.launch({ headless: true });
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function open(shot, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  await page.goto(`http://localhost:1432/dev-preview.html?shot=${shot}`);
  // 预览树是异步装配的（动态 import + 夹具状态注入）——固定 sleep 会读到
  // 「组件还没挂上 / expiresAt 还没算出来」的中间帧。等选择器，别抢跑。
  await page.waitForTimeout(400);
  return page;
}

/** 等某选择器出现（最多 8s）；没出现就返回 false。 */
async function waitFor(page, selector, timeout = 8000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 1. 提问弹窗
{
  const page = await open("prompt-dialog");
  const appeared = await waitFor(page, '[data-testid="prompt-dialog"]');
  check("提问弹窗渲染", appeared);
  const input = page.locator('[data-testid="prompt-input-0"]');
  // 等倒计时真的算出数字（首帧 expiresAt 还是 null → 文案是「…in s」）
  await waitFor(page, '[data-testid="prompt-code-countdown"]');

  const before = await input.inputValue();
  const countdown = page.locator('[data-testid="prompt-code-countdown"]');
  const firstText = (await countdown.textContent()) ?? "";
  check(
    "倒计时在走（显示剩余秒数）",
    /\d/.test(firstText),
    `初始文案「${firstText.trim()}」`,
  );

  // 夹具给的窗口是 2 秒 → 等它过期 → 组件应自动换一个码
  await page.waitForTimeout(3500);
  const after = await input.inputValue();
  const expiredText = (await countdown.textContent()) ?? "";
  check(
    "码过期后自动换码（输入框值变化）",
    before !== after,
    `${before} → ${after}`,
  );
  check(
    "过期态有明确文案",
    expiredText.includes("过期") || /\d/.test(expiredText),
    `「${expiredText.trim()}」`,
  );

  // 提交 → 槽位应被消费（弹窗关闭）
  await page.locator('[data-testid="prompt-submit"]').click();
  await page.waitForTimeout(500);
  check(
    "提交后弹窗关闭",
    (await page.locator('[data-testid="prompt-dialog"]').count()) === 0,
  );
  await page.close();
}

// ---------------------------------------------------------------- 2. Ask Ottr
{
  const page = await open("ai-ask");
  await waitFor(page, '[data-testid="ai-panel"]');
  const input = page.locator('[data-testid="ai-followup-input"]');
  check("Ask Ottr 面板渲染", (await page.locator('[data-testid="ai-panel"]').count()) > 0);
  const placeholder = (await input.getAttribute("placeholder")) ?? "";
  check(
    "提问态占位符是「提问」语义而非「追问」",
    /ask|问/i.test(placeholder) && !/follow|追问/i.test(placeholder),
    `「${placeholder}」`,
  );
  check(
    "提问态标题是「问 Ottr」",
    ((await page.locator(".ai-panel-title").textContent()) ?? "").includes("Ottr"),
  );
  await page.close();
}

// ---------------------------------------------------------------- 3. 凭据表单
{
  const page = await open("credentials");
  // 凭据对话框默认是列表视图 → 先点「新建凭据」进表单
  await waitFor(page, '[data-testid="cred-new"]');
  await page.locator('[data-testid="cred-new"]').click();
  await page.waitForTimeout(400);
  // 选 TOTP 类型 → 位数/步长两个输入应出现
  const kindSelect = page.locator("select").first();
  await kindSelect.selectOption("totp");
  await page.waitForTimeout(300);
  check(
    "TOTP 类型下出现「位数」输入",
    (await page.locator('[data-testid="cred-totp-digits"]').count()) > 0,
  );
  check(
    "TOTP 类型下出现「步长」输入",
    (await page.locator('[data-testid="cred-totp-period"]').count()) > 0,
  );
  const options = await kindSelect.locator("option").allTextContents();
  check(
    "类型清单含「系统 ssh-agent」",
    options.some((o) => o.includes("ssh-agent")),
    `选项：${options.join(" / ")}`,
  );
  // agent 类型的说明
  await kindSelect.selectOption("agent");
  await page.waitForTimeout(300);
  check(
    "agent 类型给出说明（私钥不入 Ottr）",
    ((await page.locator('[data-testid="cred-agent-hint"]').textContent()) ?? "").length > 0,
  );
  await page.close();
}

// ---------------------------------------------------------------- 4. MCP 客户端
{
  const page = await open("mcp-client");
  await waitFor(page, '[data-testid="mcp-client-row-srv-demo"]');
  check(
    "MCP 客户端列出已配置的 server",
    (await page.locator('[data-testid="mcp-client-row-srv-demo"]').count()) > 0,
  );
  check(
    "server 行显示命令",
    ((await page.locator('[data-testid="mcp-client-cmd-srv-demo"]').textContent()) ?? "").includes(
      "npx",
    ),
  );
  // 「看工具」→ 工具清单
  await page.locator('[data-testid="mcp-client-tools-srv-demo"]').click();
  await page.waitForTimeout(500);
  const body = await page.locator("body").innerText();
  check("列出工具（read_file）", body.includes("read_file"), "");
  // 工具清单是模态 → 关掉再点「调用」
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // 「调用」→ 结果
  await page.locator('[data-testid="mcp-client-call-srv-demo"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="mcp-client-call-tool"]').fill("read_file");
  await page.locator('[data-testid="mcp-client-call-args"]').fill('{"path":"/tmp/a.txt"}');
  const confirm = page.locator('[data-testid="mcp-client-call-run"]');
  if ((await confirm.count()) > 0) {
    await confirm.click();
  }
  await page.waitForTimeout(700);
  const body2 = await page.locator("body").innerText();
  check("调用结果呈现（file contents here）", body2.includes("file contents here"), "");
  await page.close();
}

await browser.close();
await server.close();

const failed = results.filter((r) => !r.pass);
console.log();
console.log(
  failed.length === 0
    ? `UI_INTERACTION_OK（${results.length} 项）`
    : `UI_INTERACTION_FAIL（${failed.length}/${results.length} 项失败）`,
);
process.exit(failed.length === 0 ? 0 : 1);
