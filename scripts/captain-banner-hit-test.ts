// Run with an empty thread on a disposable BB test instance that has Captain and Monokai installed.
// bun scripts/captain-banner-hit-test.ts <test-thread-url> [screenshot-directory]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { launchScreenshotBrowser } from "./plugin-screenshot-runtime";

const [threadUrl, outputDir] = process.argv.slice(2);
assert(threadUrl, "Pass the URL of a thread on a disposable BB test instance");
const url = new URL(threadUrl);
assert.equal(url.hostname, "127.0.0.1", "Use a local test instance");
const captainId = /\/threads\/(thr_[\w-]+)$/u.exec(url.pathname)?.[1];
assert(captainId, "Use a thread URL");

const shortDetail = "Use the shared cache.";
const longOptions = [
  "Roll out in small waves with a rollback checkpoint after each batch",
  "Switch every workspace immediately",
  "WorkspaceNotificationCacheCompatibilityCheck",
  "Keep the old cache until the migration is verified",
];
const longCommand = `bun run captain --project ${"workspace/".repeat(24)}config.json`;
const diagram = "```mermaid\nflowchart LR\n  A[Proposed] --> B[Approved]\n```";
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
                : name === "mobile-queue"
                  ? {
                      ...ask,
                      text: "Choose the rollout strategy for the workspace notification cache migration",
                      options: longOptions,
                    }
                  : ask,
              ...(name === "mobile-queue"
                ? [
                    "Confirm the migration window for accounts with queued notifications",
                    "Select the rollback strategy for accounts with overdue workspace digests",
                    "Choose the alert threshold while migrating the notification cache",
                    "Pick the next environment for the workspace notification cache experiment",
                  ].map((text, index) =>
                    Object.assign({}, ask, {
                      id: `m${index}`,
                      key: `ask:m${index}`,
                      text,
                      since: ask.since + index + 1,
                    }),
                  )
                : []),
              ...(name === "link" || name === "parallel"
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
  const answer = Promise.withResolvers<void>();
  await context.route(`${url.origin}/api/v1/plugins/captain/rpc/*`, async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").at(-1);
    if (method === "resolveAsk" && name === "parallel") {
      await answer.promise;
      await route.fulfill({
        json: {
          ok: true,
          result: { state: "undelivered", warnings: ["First answer was recorded"] },
        },
      });
    } else if (method && Object.hasOwn(captainReads, method)) {
      await route.fulfill({ json: { ok: true, result: captainReads[method] } });
    } else {
      await route.abort("blockedbyclient");
    }
  });
  return answer.resolve;
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

async function assertInlineOther(banner: Locator, mobile: boolean, screenshot?: string) {
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
  if (!mobile) assert.deepEqual(await row.boundingBox(), before);
  assert.equal(await later.count(), 0);
  if (screenshot) await banner.screenshot({ path: screenshot });
  await input.press("Escape");
  assert.equal(await other.evaluate((node) => node === document.activeElement), true);

  for (const selector of mobile
    ? ['[role="tablist"]']
    : ['[role="tablist"]', "[data-captain-answers]"]) {
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

async function assertMobileQueue(banner: Locator) {
  const strip = banner.getByRole("tablist");
  const tabs = strip.getByRole("tab");
  assert.equal(await tabs.count(), 5);
  assert.ok(
    await strip.evaluate((node) => node.scrollWidth > node.clientWidth),
    "only the tab strip scrolls horizontally",
  );
  assert.ok(
    await banner.evaluate((node) => {
      const strip = node.querySelector('[role="tablist"]');
      const panel = node.querySelector('[role="tabpanel"]');
      return (
        node.scrollWidth === node.clientWidth &&
        strip &&
        panel &&
        strip.getBoundingClientRect().bottom <= panel.getBoundingClientRect().top
      );
    }),
    "the queue fits the banner and the tabs sit above the panel",
  );
  const choices = banner.locator("[data-captain-answers]");
  assert.equal(
    await choices.evaluate((node) => node.scrollWidth === node.clientWidth),
    true,
    "all choices fit without horizontal scrolling",
  );
  for (const label of longOptions) {
    const choice = choices.getByRole("button", { name: new RegExp(label, "u") });
    const labelSpan = choice.getByText(label, { exact: true });
    assert.equal(await labelSpan.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    await choice.tap({ trial: true });
  }
  await tabs.last().tap();
  assert.equal(await tabs.last().getAttribute("aria-selected"), "true");
  await assertInlineOther(banner, true);
}

async function assertParallelAnswer(page: Page, banner: Locator, release: () => void) {
  const input = banner.getByRole("textbox", { name: "Your answer" });
  const other = banner.getByRole("button", { name: "Other…" });
  await other.click();
  await input.fill("Shared cache, with a fallback");
  const pending = page.waitForRequest((request) => request.url().endsWith("/rpc/resolveAsk"));
  await input.press("Enter");
  await pending;
  assert.equal(await input.evaluate((field: HTMLInputElement) => field.readOnly), true);

  await banner.getByRole("tab", { name: /Board column order/u }).click();
  await other.click();
  assert.equal(await input.isEditable(), true);
  await input.fill("Keep task order");
  const response = page.waitForResponse((result) => result.url().endsWith("/rpc/resolveAsk"));
  release();
  await response;
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  assert.equal(await input.evaluate((field) => field === document.activeElement), true);
  assert.equal(await input.inputValue(), "Keep task order");
  assert.equal(await banner.getByText("First answer was recorded").count(), 0);

  await input.press("Enter");
  await input.waitFor({ state: "detached" });
  const next = banner.getByRole("tab", { name: /Board column order/u });
  assert.equal(await next.evaluate((tab) => tab === document.activeElement), true);
}

async function assertDisclosure(banner: Locator, name: string) {
  const more = banner.getByRole("button", { name: "More", exact: true });
  const preview = banner.locator("[data-detail-box]");
  await more.click();
  await banner.getByRole("button", { name: "Less", exact: true }).waitFor();
  if (name === "mermaid") {
    await preview.locator("svg").filter({ hasText: "Approved" }).waitFor();
  } else if (name === "command") {
    const code = preview.locator("pre");
    assert.equal((await code.textContent())?.trim(), longCommand);
    assert.equal(
      await code.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
        return node.scrollLeft > 0;
      }),
      true,
    );
  } else {
    await preview.getByText("bun test", { exact: true }).waitFor();
  }
}

const modes = [
  { name: "desktop", width: 1096, height: 780, mobile: false, top: 0, bottom: 0 },
  { name: "393-safe-area", width: 393, height: 852, mobile: true, top: 59, bottom: 34 },
  { name: "393-no-insets", width: 393, height: 852, mobile: true, top: 0, bottom: 0 },
  { name: "390-safe-area", width: 390, height: 844, mobile: true, top: 47, bottom: 34 },
  { name: "430-safe-area", width: 430, height: 932, mobile: true, top: 59, bottom: 34 },
];
const browser = await launchScreenshotBrowser();
try {
  if (outputDir) await mkdir(outputDir, { recursive: true });
  for (const mode of modes) {
    const cases = [
      ["link", longDetail],
      ["short", shortDetail],
      ["mermaid", diagram],
      ["code", "```sh\nbun test\n```"],
      ...(mode.mobile
        ? [
            ["command", `\`\`\`sh\n${longCommand}\n\`\`\``],
            ["mobile-queue", shortDetail],
          ]
        : []),
      ...(!mode.mobile
        ? [
            ["ship", "`branch → main`\n\nReview passed."],
            ["clear", ""],
            ["parallel", shortDetail],
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
        const releaseAnswer = await seed(context, name, detail);
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
            mode.mobile,
            outputDir ? join(outputDir, `${mode.name}-other.png`) : undefined,
          );
        } else if (name === "mobile-queue") {
          await assertMobileQueue(banner);
        } else if (name === "ship") {
          await banner.getByText("Review passed.", { exact: true }).waitFor();
          await assertBalancedPadding(banner);
        } else if (name === "parallel") {
          await assertParallelAnswer(page, banner, releaseAnswer);
        } else if (name === "short") {
          await banner.getByText(shortDetail, { exact: true }).waitFor();
          await page.evaluate(
            () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
          );
          assert.equal(await banner.getByRole("button", { name: "More", exact: true }).count(), 0);
          assert.equal(await banner.locator("[data-preview-fade]").count(), 0);
        } else {
          await assertDisclosure(banner, name);
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
              // BB owns the controls inside the SDK Markdown component.
              targets: [...node.querySelectorAll("button")]
                .filter(
                  (button) =>
                    !button.closest("[data-detail-box]") &&
                    button.offsetWidth > 0 &&
                    button.offsetHeight > 0,
                )
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
