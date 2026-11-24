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
  { split = false, hint = "Choose what to work on." } = {},
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
      h2, p { margin: 0; }
      li { height: 60px; }
    </style>
    <div data-test-pane ${split ? 'data-split-pane-id="left" style="width: 50%"' : 'id="root-compose-main-panel"'}>
      ${compact ? compactHome(composer, sections) : desktopHome(composer, sections)}
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

function compactHome(composer: string, sections: string) {
  const recents = "<li>Recent conversation</li>".repeat(12);
  return `
    <div class="page column compact-home">
      <div class="compact-home" data-testid="root-compose-compact-home">
        <div class="compact-viewport" data-testid="root-compose-compact-scroll-viewport">
          <div data-testid="root-compose-compact-scroll-content">
            <div data-testid="root-compose-compact-leading-spacer" style="height: 200px"></div>
            <div>
              <section data-root-compose-mobile-recents><ul>${recents}</ul></section>
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

        if (compact) {
          const recents = page.locator("[data-root-compose-mobile-recents]");
          const bounds = await recents.boundingBox();
          if (!bounds) throw new Error("Missing compact recents");
          expect(bounds.y).toBeCloseTo(composerBottom, 0);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(contentBottom);
          expect(
            await recents.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
              return element.scrollTop;
            }),
          ).toBeGreaterThan(0);
        }
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

test("keeps recent items reachable below a tall compact heading", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.setContent(homeMarkup(true, true, { hint: "Long project hint. ".repeat(95) }));
    await page.addStyleTag({ content: theme + ".composer { height: 240px; }" });
    const recents = page.locator("[data-root-compose-mobile-recents]");
    const bounds = await recents.boundingBox();
    if (!bounds) throw new Error("Missing compact recents");
    expect(bounds.height).toBeGreaterThanOrEqual(84);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    await recents.locator("li").last().scrollIntoViewIfNeeded();
    expect(await recents.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
});
