import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";

const theme = await readFile(new URL("../themes/bb-monokai.css", import.meta.url), "utf8");
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

function homeMarkup(
  compact: boolean,
  withHeading: boolean,
  { split = false, hint = "Choose what to work on.", recentCount = 0 } = {},
) {
  const sections = `
    <div data-testid="plugin-homepage-sections">
      <section hidden>Monokai marker</section>
      ${withHeading ? `<section><h2>Start a thread</h2><p>${hint}</p></section>` : ""}
    </div>
  `;
  const composer = `
    <div class="composer ${compact ? "compact-composer" : ""}"
         data-testid="root-compose-compact-composer"></div>
  `;
  return `
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; }
      [data-test-pane] { height: 100vh; display: flex; flex-direction: column; }
      .column { display: flex; flex-direction: column; }
      .page { container: page / inline-size; }
      .desktop-viewport { overflow-y: auto; flex: 1; }
      .desktop-home { padding: 56px 16px 16px; }
      .compact-home { position: relative; flex: 1; min-height: 0; }
      .compact-viewport { position: absolute; inset: 56px 0 0; overflow-y: auto; }
      .compact-composer { position: absolute; inset: auto 0 0; }
      .composer { height: 160px; }
      [data-root-compose-mobile-recents] h2 { position: sticky; top: 0; }
      h2, p { margin: 0; }
      li { height: 60px; }
    </style>
    <div data-test-pane ${split ? 'data-split-pane-id="left" style="width: 50%"' : 'id="root-compose-main-panel"'}>
      ${compact ? compactHome(composer, sections, recentCount) : desktopHome(composer, sections)}
    </div>
  `;
}

// Mirror the two BB 0.50 DOM layouts that the theme rules select.
function desktopHome(composer: string, sections: string) {
  return `
    <div class="desktop-viewport">
      <div class="page" data-monokai-compose-viewport>
        <div class="column desktop-home" data-testid="root-compose-compact-home">
          ${composer}
          ${sections}
        </div>
      </div>
    </div>
  `;
}

function compactHome(composer: string, sections: string, recentCount: number) {
  const recents = "<li>Recent conversation</li>".repeat(recentCount);
  return `
    <div class="page column compact-home">
      <div class="compact-home" data-testid="root-compose-compact-home">
        <div class="compact-viewport" data-testid="root-compose-compact-scroll-viewport">
          <div data-testid="root-compose-compact-scroll-content">
            <div data-testid="root-compose-compact-leading-spacer" style="height: 200px"></div>
            <div>
              ${recents ? `<section data-root-compose-mobile-recents><h2>Recent</h2><ul>${recents}</ul></section>` : ""}
              ${sections}
            </div>
            <div data-testid="root-compose-compact-bottom-spacer" style="height: 160px"></div>
          </div>
        </div>
        ${composer}
      </div>
    </div>
  `;
}

const scenarios = [
  { width: 1440, height: 900, compact: false },
  { width: 390, height: 844, compact: true },
  { width: 390, height: 480, compact: true },
];

for (const { width, height, compact } of scenarios) {
  for (const withHeading of [false, true]) {
    test(`centers the composer at ${width}×${height} ${withHeading ? "with" : "without"} a heading`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.setContent(homeMarkup(compact, withHeading));
        await page.addStyleTag({ content: theme });

        const viewport = await page.locator("[data-test-pane]").boundingBox();
        const sections = await page.getByTestId("plugin-homepage-sections").boundingBox();
        const composer = await page.getByTestId("root-compose-compact-composer").boundingBox();
        if (!viewport || !composer || !sections) throw new Error("Missing new-thread layout");
        const composerBottom = composer.y + composer.height;
        const groupStart = withHeading ? sections.y : composer.y;
        const contentTop = viewport.y + (compact ? 56 : 0);
        const contentBottom = viewport.y + viewport.height;

        expect(groupStart).toBeGreaterThanOrEqual(contentTop);
        expect(composerBottom).toBeLessThanOrEqual(contentBottom);
        expect((groupStart + composerBottom) / 2).toBeCloseTo((contentTop + contentBottom) / 2, 0);
        if (withHeading) expect(composer.y - (sections.y + sections.height)).toBeCloseTo(0, 0);
      } finally {
        await page.close();
      }
    });
  }
}

test("centers the composer in a hosted pane without the root panel ID", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(homeMarkup(false, true, { split: true }));
    await page.addStyleTag({ content: theme });
    const heading = await page.getByRole("heading", { name: "Start a thread" }).boundingBox();
    const composer = await page.getByTestId("root-compose-compact-composer").boundingBox();
    if (!heading || !composer) throw new Error("Missing split-pane composer group");
    expect((heading.y + composer.y + composer.height) / 2).toBeCloseTo(450, 0);
  } finally {
    await page.close();
  }
});

test("keeps the hint and recents reachable below a large composer with a short viewport", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 480 } });
  try {
    await page.setContent(
      homeMarkup(true, true, { hint: "Long project hint. ".repeat(95), recentCount: 12 }),
    );
    await page.addStyleTag({ content: theme + ".composer { height: 240px; }" });
    const sections = await page.getByTestId("plugin-homepage-sections").boundingBox();
    expect(sections?.height).toBeGreaterThan(480);
    const last = page.locator("[data-root-compose-mobile-recents] li").last();
    await last.scrollIntoViewIfNeeded();
    const bounds = await last.boundingBox();
    expect(bounds?.y).toBeGreaterThanOrEqual(56);
    expect((bounds?.y ?? 480) + (bounds?.height ?? 60)).toBeLessThanOrEqual(480);
  } finally {
    await page.close();
  }
});

for (const inset of [0, 47]) {
  test(`fits the six-line draft and slash menu in the keyboard viewport with a ${inset}px top inset`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 480 } });
    try {
      await page.setContent(homeMarkup(true, false));
      await page.addStyleTag({
        content:
          theme +
          `
          [data-test-pane] { padding-block-start: ${inset}px; }
          .composer { height: auto; padding-block-end: 90px; }
          [data-promptbox] {
            position: relative;
            --composer-editor-available-height: calc(100vh - ${inset}px - 56px - 56px - 90px);
          }
          [data-promptbox-editor-scroll] { overflow-y: auto; line-height: 32px; }
          [data-promptbox-typeahead-menu] {
            position: absolute;
            inline-size: 100%;
            block-size: 5rem;
          }
        `,
      });
      const composer = page.getByTestId("root-compose-compact-composer");
      await composer.evaluate((element) => {
        element.innerHTML = `
          <div data-promptbox>
            <div data-promptbox-editor-scroll><div contenteditable></div></div>
          </div>`;
      });
      await composer.locator("[contenteditable]").fill("Draft line\n".repeat(6) + "/");
      await composer.locator("[data-promptbox]").evaluate((element) => {
        const menu = document.createElement("div");
        menu.setAttribute("data-promptbox-typeahead-menu", "");
        menu.innerHTML = '<button aria-label="Close suggestions">×</button>';
        element.append(menu);
      });
      const viewport = await page.getByTestId("root-compose-compact-home").boundingBox();
      const menu = await composer.locator("[data-promptbox-typeahead-menu]").boundingBox();
      const draftBounds = await composer.boundingBox();
      if (!viewport || !menu || !draftBounds) throw new Error("Missing menu or composer");
      expect(menu.y).toBeGreaterThanOrEqual(viewport.y);
      expect(menu.y + menu.height).toBeLessThan(draftBounds.y);
      expect(draftBounds.y + draftBounds.height).toBeLessThanOrEqual(480 - 24);
      await composer.getByRole("button", { name: "Close suggestions" }).click({ trial: true });
    } finally {
      await page.close();
    }
  });
}

for (const [width, height] of [
  [440, 956],
  [390, 844],
] as const) {
  test(`centers the composer above scrollable recents at ${width}×${height}`, async () => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.setContent(homeMarkup(true, false, { recentCount: 18 }));
      await page.addStyleTag({ content: theme + ".composer { height: 240px; }" });
      const home = page.getByTestId("root-compose-compact-home");
      const composer = await page.getByTestId("root-compose-compact-composer").boundingBox();
      const recents = page.locator("[data-root-compose-mobile-recents]");
      const top = await recents.boundingBox();
      if (!composer || !top) throw new Error("Missing composer or recents");
      expect(composer.y + composer.height / 2).toBeCloseTo((56 + height) / 2, 0);
      expect(top.y).toBeCloseTo(height, 0);
      expect(await home.evaluate((element) => getComputedStyle(element).maskImage)).toContain(
        "linear-gradient",
      );

      await home.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const last = await recents.locator("li").last().boundingBox();
      if (!last) throw new Error("Missing recent item at the end");
      expect(last.y + last.height).toBeLessThanOrEqual(height - 48);
      const stickyHeading = await recents.getByRole("heading").boundingBox();
      expect(stickyHeading?.y).toBeCloseTo(56, 0);
      expect(await recents.evaluate((element) => element.scrollTop)).toBe(0);
    } finally {
      await page.close();
    }
  });
}
