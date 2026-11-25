// Run with: bun plugins/gtd-sidebar/test/more-pinning.browser.ts <test bb server URL>
// The test instance must have GTD Sidebar enabled. Preferences are set only in this browser.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const serverUrl = process.argv[2];
assert.ok(serverUrl, "Pass the isolated BB test server URL");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 440, height: 440 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
  page.setDefaultTimeout(30_000);
  await page.addInitScript(() => localStorage.setItem("bb.onboarding.seen", "1"));
  await page.route("**/api/v1/preferences/ui", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body.preferences, {
      "sidebar.navigationProvider": { revision: 1, value: "gtd-sidebar/capy-list" },
      "sidebar.visiblePluginPanels": {
        revision: 1,
        value: ["__bb__/new-thread", "__bb__/search-threads"],
      },
    });
    await route.fulfill({ response, json: body });
  });

  await page.goto(serverUrl);
  const drawer = page.locator('[data-sidebar="inset"]');
  if ((await drawer.getAttribute("data-sidebar-shelf")) !== "open") {
    await page.locator('button[data-sidebar="trigger"]').first().click();
  }
  const nav = page.getByRole("navigation", { name: "Navigation" });
  const scroller = nav.locator("[data-gtd-nav-scroll]");
  const more = nav.getByRole("button", { name: "More", exact: true });
  await more.waitFor();
  const before = await more.boundingBox();
  assert.ok(before);
  const visibleDrawer = await more.evaluate((button) => {
    const sidebar = button.closest('[data-sidebar="sidebar"]');
    if (!sidebar) throw new Error("More must be inside the drawer");
    const { left, top, right, bottom } = sidebar.getBoundingClientRect();
    return {
      left: Math.max(left, 0),
      top: Math.max(top, 0),
      right: Math.min(right, window.innerWidth),
      bottom: Math.min(bottom, window.innerHeight),
    };
  });
  assert.ok(
    before.x >= visibleDrawer.left &&
      before.y >= visibleDrawer.top &&
      before.x + before.width <= visibleDrawer.right &&
      before.y + before.height <= visibleDrawer.bottom,
    "More must be fully inside the visible drawer",
  );
  const scrollTop = await scroller.evaluate((element) => element.scrollTop);
  await scroller.hover();
  await page.mouse.wheel(0, 120);
  await page
    .waitForFunction(
      (top) => {
        const rows = document.querySelector("[data-gtd-nav-scroll]");
        return rows !== null && rows.scrollTop > top;
      },
      scrollTop,
      { timeout: 3000 },
    )
    .catch(() => assert.fail("The navigation rows did not scroll after a wheel gesture"));
  const after = await more.boundingBox();
  assert.deepEqual(after, before, "More should stay pinned while the navigation rows scroll");
  console.log({
    scrollTop,
    scrolledTo: await scroller.evaluate((element) => element.scrollTop),
    more: after,
  });
} finally {
  await browser.close();
}
