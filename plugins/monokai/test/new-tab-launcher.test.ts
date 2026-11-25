import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

import { NEW_TAB_LAUNCHER_CSS } from "../app/new-tab-launcher.ts";
import { SEARCH_FIELDS_CSS } from "../app/search-fields.ts";

const actions = [
  { id: "file-search-result-start-terminal", name: "Start terminal", short: "Terminal" },
  { id: "plugin-action:side-chat:side-chat", name: "Start side chat", short: "Side chat" },
];

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function mountLauncher(page: Page) {
  // Mirror the host's mounted shelf and action rows, including its closed
  // visibility rule. The browser computes the cascade for real pseudo-elements.
  await page.setContent(`
    <style>
      [data-testid="secondary-panel-shelf"][data-state="closed"] { visibility: hidden; }
      .text-foreground { color: rgb(235, 235, 236); }
    </style>
    <div data-testid="secondary-panel-shelf" data-state="full">
      <div data-panel-new-tab-page>
        <div>
          <div data-testid="new-tab-actions">
            <section>
              <div>Actions</div>
              <div>
                ${actions
                  .map(
                    ({ id, name }) => `<div>
                      <button id="${id}" title="${name}" data-panel-new-tab-item>
                        <span aria-hidden="true">+</span><span class="text-foreground">${name}</span>
                      </button>
                    </div>`,
                  )
                  .join("")}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  `);
  await page.addStyleTag({ content: NEW_TAB_LAUNCHER_CSS });
  return page.getByTestId("secondary-panel-shelf");
}

for (const forcedColors of ["none", "active"] as const) {
  test(`launcher paints one label per action and hides it with the shelf (${forcedColors})`, async () => {
    const page = await browser.newPage({
      forcedColors,
      hasTouch: true,
      isMobile: true,
      viewport: { width: 393, height: 852 },
    });

    try {
      const shelf = await mountLauncher(page);
      const labels = () =>
        shelf.locator("button[data-panel-new-tab-item] > span:nth-child(2)").evaluateAll((spans) =>
          spans.map((span) => {
            const source = getComputedStyle(span);
            const generated = getComputedStyle(span, "::after");
            return {
              name: span.textContent,
              color: source.color,
              sourceVisibility: source.visibility,
              sourceFill: source.webkitTextFillColor,
              generatedVisibility: generated.visibility,
              generatedFill: generated.webkitTextFillColor,
              generatedContent: generated.content,
            };
          }),
        );

      const open = await labels();
      await shelf.evaluate((element) => element.setAttribute("data-state", "closed"));
      expect(await shelf.evaluate((element) => getComputedStyle(element).visibility)).toBe(
        "hidden",
      );
      expect(await labels()).toEqual(
        open.map((label) => ({
          ...label,
          sourceVisibility: "hidden",
          generatedVisibility: "hidden",
        })),
      );
      await shelf.evaluate((element) => element.setAttribute("data-state", "full"));

      expect(open).toEqual(
        actions.map(({ name, short }) =>
          expect.objectContaining({
            name,
            sourceVisibility: "visible",
            generatedVisibility: "visible",
            generatedContent: forcedColors === "active" ? "none" : `"${short}" / ""`,
          }),
        ),
      );
      for (const label of open) {
        if (forcedColors === "active") {
          expect(label.sourceFill).toBe(label.color);
        } else {
          expect(label.sourceFill).toBe("rgba(0, 0, 0, 0)");
          expect(label.generatedFill).toBe(label.color);
        }
      }
      for (const { name } of actions) {
        expect(await shelf.getByRole("button", { name, exact: true }).count()).toBe(1);
      }
    } finally {
      await page.close();
    }
  });
}

test("keeps file-search statuses visible and hides Recent inside the results sibling", async () => {
  const page = await browser.newPage();
  try {
    const shelf = await mountLauncher(page);
    const actions = shelf.getByTestId("new-tab-actions");
    await actions.evaluate((element) =>
      element.insertAdjacentHTML(
        "afterend",
        "<div><p>No searchable source is available.</p></div>",
      ),
    );
    expect(await shelf.getByText("No searchable source is available.").isVisible()).toBe(true);
    const results = shelf.locator('[data-testid="new-tab-actions"] + div');
    await results.evaluate((element) => {
      element.innerHTML = "<p>Type to search files.</p>";
    });
    expect(await shelf.getByText("Type to search files.").isVisible()).toBe(true);

    await results.evaluate((element) => {
      element.innerHTML = `
        <div role="listbox">
          <section role="group" aria-label="Recent">Opened file</section>
          <section role="group" aria-label="Files">Matching file</section>
        </div>
        <section>Plans, mockups, and files you open will show up here.</section>
        <button data-panel-new-tab-item aria-expanded="false">Show more</button>
      `;
    });
    for (const text of ["Opened file", "Plans, mockups, and files you open", "Show more"]) {
      const element = shelf.getByText(text);
      expect(await element.count()).toBe(1);
      expect(await element.isVisible()).toBe(false);
    }
    expect(await shelf.getByText("Matching file").isVisible()).toBe(true);
  } finally {
    await page.close();
  }
});

test("styles the BB search but preserves the composer model search height", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <style>input { height: 24px; box-sizing: border-box; }</style>
      <div data-t3-model-picker-popover>
        <div class="border-b"><input data-t3-model-search aria-label="Search models"></div>
      </div>
      <input aria-label="Search files">
    `);
    await page.addStyleTag({ content: SEARCH_FIELDS_CSS });
    const height = (name: string) =>
      page.getByLabel(name).evaluate((element) => getComputedStyle(element).height);
    expect(await height("Search models")).toBe("24px");
    expect(await height("Search files")).toBe("36px");
  } finally {
    await page.close();
  }
});
