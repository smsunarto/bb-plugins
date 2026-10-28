// Screenshots gallery examples as BB renders them, for visual checks without
// a thread. Needs the plugin built and reloaded (`bb plugin build && bb plugin
// reload genui`) and a running BB.
//
//   node scripts/gallery-shot.mjs <name>... [--out dir] [--mobile] [--dark] [--webkit]
//                                 [--click "text"]... [--wait ms] [--thread thr_…] [--url http://127.0.0.1:38886]
//
// <name> is a gallery/<name>.ui file without the extension. --mobile is an
// iPhone-sized touch viewport (WebKit unless --chromium). --click presses the
// first button with that accessible name inside the example before the shot
// (repeatable, in order). --thread renders against that thread, for components
// that read a thread's own state. Prints one JSON line per example: the PNG
// path, the width, error lines, page errors and whether anything overflows
// horizontally.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, devices, webkit } from "playwright-core";

const args = process.argv.slice(2);
const names = [];
const clicks = [];
let out = "/tmp/genui-gallery";
let base = process.env.BB_URL ?? "http://127.0.0.1:38886";
let wait = 2500;
let mobile = false;
let dark = false;
let engineName = null;
let thread = null;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--out") out = args[++index];
  else if (arg === "--url") base = args[++index];
  else if (arg === "--wait") wait = Number(args[++index]);
  else if (arg === "--click") clicks.push(args[++index]);
  else if (arg === "--thread") thread = args[++index];
  else if (arg === "--mobile") mobile = true;
  else if (arg === "--dark") dark = true;
  else if (arg === "--webkit") engineName = "webkit";
  else if (arg === "--chromium") engineName = "chromium";
  else names.push(arg);
}
if (names.length === 0) {
  console.error("usage: node scripts/gallery-shot.mjs <name>... [--out dir] [--mobile] [--dark] [--webkit] [--click text]");
  process.exit(2);
}
const engine = (engineName ?? (mobile ? "webkit" : "chromium")) === "webkit" ? webkit : chromium;
mkdirSync(out, { recursive: true });

const browser = await engine.launch();
const context = await browser.newContext({
  ...(mobile ? { ...devices["iPhone 15"], viewport: { width: 393, height: 3000 } } : { viewport: { width: 1300, height: 2400 } }),
  ...(mobile && engine === chromium ? { defaultBrowserType: undefined } : {}),
  colorScheme: dark ? "dark" : "light",
});
for (const name of names) {
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message ?? error)));
  const query = thread === null ? "" : `?thread=${encodeURIComponent(thread)}`;
  await page.goto(`${base}/plugins/genui/gallery/${encodeURIComponent(name)}${query}`, { waitUntil: "domcontentloaded" });
  const entry = page.locator(`[data-gallery-entry="${name}"]`);
  try {
    await entry.locator(".group\\/genui").first().waitFor({ timeout: 30_000 });
  } catch {
    console.log(JSON.stringify({ name, ok: false, error: "the example did not render", pageErrors }));
    await page.close();
    continue;
  }
  await page.waitForTimeout(wait);
  for (const label of clicks) {
    await entry.getByRole("button", { name: label, exact: true }).first().click();
    await page.waitForTimeout(800);
  }
  await entry.scrollIntoViewIfNeeded();
  const info = await entry.evaluate((element) => ({
    width: Math.round(element.getBoundingClientRect().width),
    errors: [...element.querySelectorAll("p.text-destructive")].map((line) => line.textContent),
    overflowing: [...element.querySelectorAll("*")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === "visible")
      .slice(0, 5)
      .map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)}`),
  }));
  const file = path.join(out, `${name}${mobile ? "-mobile" : ""}${dark ? "-dark" : ""}${clicks.length > 0 ? "-clicked" : ""}.png`);
  await entry.screenshot({ path: file });
  console.log(JSON.stringify({ name, ok: true, path: file, ...info, pageErrors: pageErrors.filter((error) => !/ResizeObserver/.test(error)) }));
  await page.close();
}
await browser.close();
