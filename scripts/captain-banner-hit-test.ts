// Run with an empty thread on a disposable BB test instance that has Captain and Monokai installed.
// bun scripts/captain-banner-hit-test.ts <test-thread-url> [screenshot-directory]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Locator } from "playwright";
import { launchScreenshotBrowser } from "./plugin-screenshot-runtime";

const [threadUrl, outputDir] = process.argv.slice(2);
assert(threadUrl, "Pass the URL of a thread on a disposable BB test instance");
const url = new URL(threadUrl);
assert.equal(url.hostname, "127.0.0.1", "Use a local test instance");
const captainId = /\/threads\/(thr_[\w-]+)$/u.exec(url.pathname)?.[1];
assert(captainId, "Use a thread URL");

const longDetail = [
  "The first line explains the choice.",
  "The second line describes the tradeoff.",
  "The third line gives the context.",
  "[Visible link](https://example.com) in the fourth line.",
  "The fifth line.",
  "The sixth line is clipped until expanded.",
].join("\n\n");

async function seed(context: BrowserContext, name: string, detail: string) {
  await context.addInitScript(
    (mode) => localStorage.setItem("bb.theme", mode),
    name === "ship" ? "light" : "dark",
  );
  const ask = {
    kind: "ask",
    key: "ask:a1",
    id: "a1",
    askKind: "decision",
    text: "Pick a cache backend",
    detail,
    options: ["Redis", "SQLite", "No cache"],
    task: "FIXTURE-1",
    since: Date.now(),
    answer: null,
    snoozedUntil: null,
    skipOrder: null,
  };
  const captainReads: Record<string, unknown> = {
    captains: { ids: [captainId] },
    asks: {
      items:
        name === "clear"
          ? []
          : [
              name === "ship"
                ? {
                    ...ask,
                    askKind: "ship",
                    text: "Merge PR #212 · Stacked PR card",
                    options: ["Merge", "Hold"],
                  }
                : ask,
              ...(name === "link"
                ? [
                    {
                      ...ask,
                      id: "a2",
                      key: "ask:a2",
                      text: "Board column order",
                      since: ask.since + 1,
                    },
                    {
                      ...ask,
                      id: "a3",
                      key: "ask:a3",
                      text: "Stacked PR card",
                      since: ask.since + 2,
                    },
                  ]
                : []),
            ],
    },
    crew: { items: [] },
    crewThreads: { threads: [] },
    drive: { total: 0, truncated: false, files: [], folder: null },
  };
  await context.route(`${url.origin}/api/v1/plugins/captain/rpc/*`, async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").at(-1);
    if (method && Object.hasOwn(captainReads, method)) {
      await route.fulfill({ json: { ok: true, result: captainReads[method] } });
    } else {
      await route.abort("blockedbyclient");
    }
  });
}

async function assertSeparateHitAreas(banner: Locator) {
  const more = banner.getByRole("button", { name: "More", exact: true });
  await more.waitFor();
  const hits = await banner.evaluate((node) => {
    const preview = node.querySelector<HTMLElement>("[data-detail-box]")!;
    const link = preview.querySelector("a")!;
    const button = [...node.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === "More",
    )!;
    function hit(element: HTMLElement) {
      const { left, top, width, height } = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(left + width / 2, top + height / 2));
    }
    return {
      link: hit(link),
      more: hit(button),
      separate: button.getBoundingClientRect().top >= preview.getBoundingClientRect().bottom,
      fadeClipped:
        getComputedStyle(preview.parentElement!, "::after").pointerEvents === "none" &&
        parseFloat(getComputedStyle(preview.parentElement!, "::after").height) <=
          preview.clientHeight,
    };
  });
  assert.deepEqual(hits, { link: true, more: true, separate: true, fadeClipped: true });
  await more.click();
  await banner.getByRole("button", { name: "Less", exact: true }).click();
}

async function assertBalancedPadding(banner: Locator) {
  const insets = await banner.getByRole("tabpanel").evaluate((panel) => {
    const content = panel.querySelector("[data-detail-box]")!.getBoundingClientRect();
    const frame = panel.getBoundingClientRect();
    return [content.left - frame.left, frame.right - content.right];
  });
  assert.ok(Math.abs(insets[0]! - insets[1]!) < 1, `Panel insets differ: ${insets}`);
}

async function assertInlineOther(banner: Locator, screenshot?: string) {
  const other = banner.getByRole("button", { name: "Other…" });
  const later = banner.getByRole("button", { name: "Later" });
  assert.equal(
    await later.evaluate((button) => button.nextElementSibling?.getAttribute("aria-label")),
    "Other…",
  );
  assert.equal(await other.locator("svg[aria-hidden=true]").count(), 1);
  const row = banner.locator("[data-captain-answer-row]");
  const before = await row.boundingBox();
  await other.click();
  const input = banner.getByRole("textbox", { name: "Your answer" });
  await input.fill("Keep task order");
  assert.equal(await input.evaluate((node) => node === document.activeElement), true);
  assert.deepEqual(await row.boundingBox(), before);
  assert.equal(await later.count(), 0);
  if (screenshot) await banner.screenshot({ path: screenshot });
  await input.press("Escape");
  assert.equal(await other.evaluate((node) => node === document.activeElement), true);

  for (const selector of ['[role="tablist"]', "[data-captain-answers]"]) {
    const state = await banner.locator(selector).evaluate((node) => {
      const { scrollbarWidth, overflowX } = getComputedStyle(node);
      const canScroll = node.scrollWidth > node.clientWidth;
      const previous = node.scrollLeft;
      if (canScroll) node.scrollLeft = previous === 0 ? 20 : 0;
      return { scrollbarWidth, overflowX, scrolls: !canScroll || node.scrollLeft !== previous };
    });
    assert.deepEqual(state, { scrollbarWidth: "none", overflowX: "auto", scrolls: true });
  }
}

const modes = [
  { name: "desktop", width: 1096, height: 780, mobile: false, top: 0, bottom: 0 },
  { name: "393-safe-area", width: 393, height: 852, mobile: true, top: 59, bottom: 34 },
  { name: "393-no-insets", width: 393, height: 852, mobile: true, top: 0, bottom: 0 },
  { name: "390-safe-area", width: 390, height: 852, mobile: true, top: 59, bottom: 34 },
];
const browser = await launchScreenshotBrowser();
try {
  if (outputDir) await mkdir(outputDir, { recursive: true });
  for (const mode of modes) {
    const cases = [
      ["link", longDetail],
      ["short", "```sh\nbun test\n```"],
      ...(!mode.mobile
        ? [
            ["ship", "`branch → main`\n\nReview passed."],
            ["clear", ""],
          ]
        : []),
    ];
    for (const [name, detail] of cases) {
      assert(name !== undefined && detail !== undefined);
      const context = await browser.newContext({
        viewport: { width: mode.width, height: mode.height },
        deviceScaleFactor: mode.mobile ? 3 : 1,
        colorScheme: "dark",
        isMobile: mode.mobile,
        hasTouch: mode.mobile,
      });
      try {
        await seed(context, name, detail);
        const page = await context.newPage();
        if (mode.mobile) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setSafeAreaInsetsOverride", {
            insets: { top: mode.top, bottom: mode.bottom, left: 0, right: 0 },
          });
        }
        await page.goto(url.href);
        await page.waitForFunction(
          (dark) => document.documentElement.classList.contains("dark") === dark,
          name !== "ship",
        );
        if (name === "clear") {
          await page.getByText("All clear", { exact: true }).waitFor();
          if (outputDir)
            await page
              .getByText("All clear", { exact: true })
              .locator("..")
              .screenshot({ path: join(outputDir, "all-clear.png") });
          await page.getByRole("button", { name: "Overview", exact: true }).click();
          await page.getByTestId("captain-overview").waitFor();
          console.log("desktop All clear opened Overview");
          continue;
        }
        const banner = page.getByTestId("captain-needs-you");
        await banner.waitFor();
        if (name === "link") {
          await assertSeparateHitAreas(banner);
          await assertBalancedPadding(banner);
          await assertInlineOther(
            banner,
            outputDir ? join(outputDir, `${mode.name}-other.png`) : undefined,
          );
        } else if (name === "ship") {
          await banner.getByText("Review passed.", { exact: true }).waitFor();
          await assertBalancedPadding(banner);
        } else {
          await banner.getByText("bun test", { exact: true }).waitFor();
          await page.evaluate(
            () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
          );
          assert.equal(await banner.getByRole("button", { name: "More", exact: true }).count(), 0);
          assert.equal(await banner.locator("[data-preview-fade]").count(), 0);
        }
        if (mode.mobile) {
          const dimensions = await banner.evaluate((node) => {
            const insets = document.createElement("div");
            insets.style.cssText =
              "position:absolute;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
            document.body.append(insets);
            const style = getComputedStyle(insets);
            const result = {
              width: innerWidth,
              top: parseFloat(style.paddingTop),
              bottom: parseFloat(style.paddingBottom),
              touch: matchMedia("(pointer: coarse)").matches,
              targets: [...node.querySelectorAll("button")]
                .filter((button) => button.offsetWidth > 0 && button.offsetHeight > 0)
                .every((button) => button.offsetHeight >= 44 && button.offsetWidth >= 44),
            };
            insets.remove();
            return result;
          });
          assert.deepEqual(dimensions, {
            width: mode.width,
            top: mode.top,
            bottom: mode.bottom,
            touch: true,
            targets: true,
          });
        }
        if (outputDir) {
          await page.screenshot({ path: join(outputDir, `${mode.name}-${name}.png`) });
          await banner.screenshot({ path: join(outputDir, `${mode.name}-${name}-banner.png`) });
        }
        console.log(`${mode.name} ${name} passed`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
