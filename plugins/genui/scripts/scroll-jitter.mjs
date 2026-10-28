// Measures how much a BB thread's conversation moves under the reader while
// they scroll it: the regression check for scroll jitter. Scrolls the thread
// up with the mouse wheel and, after each step, watches the element in the
// middle of the view for 900 ms; any movement then is content resizing
// (nothing is scrolling). Compare with --off, the same page without this
// plugin, which is BB's own baseline.
//
//   node scripts/scroll-jitter.mjs <threadId> [--off] [--steps 40] [--profile dir]
//                                  [--verbose] [--url http://127.0.0.1:38886]
//
// --profile keeps a browser profile between runs (localStorage survives, like
// a returning user). --verbose prints each step and, where the view moved,
// the rows and genui mounts that resized and the layout shifts' sources.
// Prints one JSON summary line: totalDriftPx is the number to watch.
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const thread = args.find((arg) => /^thr_[a-z0-9]+$/.test(arg));
if (thread === undefined) {
  console.error("usage: node scripts/scroll-jitter.mjs <threadId> [--off] [--steps N] [--profile dir] [--verbose]");
  process.exit(2);
}
const off = args.includes("--off");
const verbose = args.includes("--verbose");
const steps = Number(option("--steps", "24"));
const base = option("--url", process.env.BB_URL ?? "http://127.0.0.1:38886");
const project = option("--project", null);
const profile = option("--profile", null);
const WHEEL = 260;

const contextOptions = { viewport: { width: 1300, height: 1000 }, colorScheme: "dark" };
const browser = profile === null ? await chromium.launch() : null;
const context = profile === null ? await browser.newContext(contextOptions) : await chromium.launchPersistentContext(profile, contextOptions);
const page = await context.newPage();

if (off) {
  // BB without this plugin, in this page only.
  await page.route("**/api/v1/plugins", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const drop = (list) => list.filter((plugin) => !JSON.stringify(plugin).includes('"genui"'));
    const filtered = Array.isArray(body)
      ? drop(body)
      : Object.fromEntries(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? drop(value) : value]));
    await route.fulfill({ response, json: filtered });
  });
}

await page.addInitScript(() => {
  window.__jitter = { shifts: [], sizes: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const sources = (entry.sources ?? []).map((source) => {
        const node = source.node;
        if (!node?.closest) return "?";
        const mount = node.closest("[data-genui-fence]");
        return `${mount ? `GENUI(${mount.getAttribute("data-genui-renderer") ?? "unknown"}) ` : ""}${node.tagName}.${String(node.className?.baseVal ?? node.className ?? "").slice(0, 30)}`;
      });
      window.__jitter.shifts.push({ t: entry.startTime, value: entry.value, sources: sources.join(" | ") });
    }
  }).observe({ type: "layout-shift" });
  const last = new WeakMap();
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const element = entry.target;
      const height = Math.round(entry.contentRect.height);
      const from = last.get(element);
      last.set(element, height);
      if (from === undefined || from === 0 || height === 0 || Math.abs(height - from) < 2) continue;
      const row = element.closest("[data-timeline-row-id]")?.getAttribute("data-timeline-row-id") ?? "";
      const renderer = element.getAttribute("data-genui-renderer");
      window.__jitter.sizes.push({ t: performance.now(), kind: element.hasAttribute("data-genui-fence") ? "genui" : "row", renderer, from, height, row: row.slice(-28) });
    }
  });
  new MutationObserver(() => {
    for (const element of document.querySelectorAll("[data-genui-fence], [data-timeline-row-id]")) {
      if (element.__jitterObserved) continue;
      element.__jitterObserved = true;
      resize.observe(element);
    }
  }).observe(document, { childList: true, subtree: true });
});

const projectId = project ?? (await (await fetch(`${base}/api/v1/threads/${thread}`)).json()).projectId;
await page.goto(`${base}/projects/${projectId}/threads/${thread}`, { waitUntil: "domcontentloaded" });
const scroller = page.locator(".thread-scrollbar").first();
await scroller.waitFor({ timeout: 120_000 });
await page.waitForTimeout(6000);
const box = await scroller.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

const results = [];
for (let step = 0; step < steps; step++) {
  const before = await scroller.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, -WHEEL);
  await page.waitForTimeout(120);
  const result = await scroller.evaluate(async (element) => {
    const rect = element.getBoundingClientRect();
    let anchor = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    while (anchor && anchor.getBoundingClientRect().height > rect.height / 2) anchor = anchor.firstElementChild;
    if (!anchor) return { drift: 0, scrollTop: element.scrollTop };
    const top = anchor.getBoundingClientRect().top;
    const start = performance.now();
    let drift = 0;
    await new Promise((resolve) => {
      const tick = () => {
        if (anchor.isConnected) drift = Math.max(drift, Math.abs(anchor.getBoundingClientRect().top - top));
        if (performance.now() < start + 900) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const within = (entry) => entry.t >= start - 150 && entry.t <= start + 900;
    return {
      drift: Math.round(drift),
      scrollTop: element.scrollTop,
      shift: Number(window.__jitter.shifts.filter((entry) => entry.t >= start).reduce((sum, entry) => sum + entry.value, 0).toFixed(4)),
      resized: drift > 2 ? window.__jitter.sizes.filter(within).map((entry) => ({ ...entry, t: Math.round(entry.t - start) })) : [],
      shifts: drift > 2 ? window.__jitter.shifts.filter((entry) => entry.t >= start && entry.value > 0.005).map((entry) => `${entry.value.toFixed(3)} ${entry.sources}`) : [],
    };
  });
  results.push({ step, moved: before - (await scroller.evaluate((element) => element.scrollTop)), ...result });
  if (result.scrollTop === 0) break;
}

const summary = {
  thread,
  off,
  steps: results.length,
  mounts: await page.evaluate(() => ({
    slot: document.querySelectorAll('[data-genui-renderer="slot"]').length,
    overlay: document.querySelectorAll('[data-genui-renderer="overlay"]').length,
    hidden: document.querySelectorAll("[data-genui-hidden]").length,
  })),
  stepsWithDrift: results.filter((result) => result.drift > 2).length,
  totalDriftPx: results.reduce((sum, result) => sum + result.drift, 0),
  maxDriftPx: Math.max(0, ...results.map((result) => result.drift)),
  layoutShift: Number(results.reduce((sum, result) => sum + (result.shift ?? 0), 0).toFixed(4)),
};
console.log(JSON.stringify(summary));
if (verbose) for (const result of results) console.log(JSON.stringify(result));
await (browser ?? context).close();
