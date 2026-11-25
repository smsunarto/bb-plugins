// bun scripts/source-control-pr-link-layout.ts <isolated-bb-thread-url> [screenshot-directory]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REVIEW_AVAILABLE_EVENT } from "../packages/review-request/src/review-request";
import { launchScreenshotBrowser } from "./plugin-screenshot-runtime";

const [threadUrl, outputDir] = process.argv.slice(2);
assert(threadUrl, "Pass the URL of a disposable thread on the isolated BB instance");
const url = new URL(threadUrl);
assert.equal(url.hostname, "127.0.0.1");
const threadId = /\/threads\/(thr_[\w-]+)$/.exec(url.pathname)?.[1];
assert(threadId, "Pass a thread URL");

const repo = `checkout-${"averylongrepositoryname".repeat(4)}`;
const ref = `acme/${repo}#47984`;
const href = `https://github.com/acme/${repo}/pull/47984`;
const problem = `No signed-in GitHub account can see acme/${repo}.`;
const browser = await launchScreenshotBrowser();
try {
  if (outputDir) await mkdir(outputDir, { recursive: true });
  for (const viewport of [
    { width: 1200, height: 800 },
    { width: 402, height: 874 },
  ]) {
    const context = await browser.newContext({
      viewport,
      colorScheme: "dark",
      reducedMotion: "reduce",
      hasTouch: viewport.width < 500,
    });
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let calls = 0;
    try {
      await context.addInitScript(() => localStorage.setItem("bb.theme", "dark"));
      await context.route(
        `${url.origin}/api/v1/plugins/source-control/rpc/legacyChange`,
        async (route) => {
          calls++;
          await (calls === 1 ? first.promise : second.promise);
          const result = { [`pr:${ref}`]: { key: null, problem } };
          await route.fulfill({ json: { ok: true, result } });
        },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      await page.goto(url.href);
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains("dark") &&
          getComputedStyle(document.documentElement)
            .getPropertyValue("--bb-monokai-active")
            .trim() === "1",
      );
      await page.waitForFunction(
        ({ eventName, threadId }) =>
          !window.dispatchEvent(
            new CustomEvent(eventName, { detail: { threadId }, cancelable: true }),
          ),
        { eventName: REVIEW_AVAILABLE_EVENT, threadId },
      );
      // The installed content script routes this plain anchor through the registered Review tab.
      await page.evaluate((address) => {
        const anchor = document.createElement("a");
        anchor.href = address;
        anchor.textContent = "Open QA pull request";
        anchor.style.cssText = "position: fixed; top: 110px; left: 50%; z-index: 2147483000;";
        document.body.append(anchor);
      }, href);
      const link = page.getByRole("link", { name: "Open QA pull request" });
      // A refused fixture click stays in this page.
      await page.evaluate(() =>
        document.addEventListener("click", (event) => event.preventDefault(), { once: true }),
      );
      await link.click();
      await link.evaluate((anchor) => anchor.remove());
      const frame = page.getByTestId("sc-pull-request-tab");
      const heading = frame.getByText(ref, { exact: true });
      const headingY = () => heading.evaluate((node) => node.getBoundingClientRect().top);
      const alert = frame.getByRole("alert");
      await frame.getByRole("status").waitFor();
      const loadingY = await headingY();
      if (outputDir)
        await page.screenshot({ path: join(outputDir, `${viewport.width}-loading.png`) });
      first.resolve();
      assert.equal(await alert.textContent(), problem);
      const errorY = await headingY();
      assert(Math.abs(loadingY - errorY) < 1, `Heading moved from ${loadingY}px to ${errorY}px`);
      const widths = await frame.evaluate((node) => ({
        rendered: node.clientWidth,
        content: node.scrollWidth,
      }));
      assert(
        widths.content <= widths.rendered,
        `Alert creates horizontal overflow: ${JSON.stringify(widths)}`,
      );
      if (outputDir)
        await page.screenshot({ path: join(outputDir, `${viewport.width}-error.png`) });

      await frame.getByRole("button", { name: "Try again" }).click();
      await frame.getByRole("status").waitFor();
      const retryY = await headingY();
      assert(
        Math.abs(loadingY - retryY) < 1,
        `Heading moved from ${loadingY}px to ${retryY}px on retry`,
      );
      second.resolve();
      await alert.waitFor();
      assert.equal(calls, 2);
      console.log(JSON.stringify({ viewport, loadingY, errorY, retryY, widths, calls }));
    } finally {
      first.resolve();
      second.resolve();
      await context.close();
    }
  }
} finally {
  await browser.close();
}
