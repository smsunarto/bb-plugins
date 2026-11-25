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
  { split = false, recentCount = 0 } = {},
) {
  const sections = `
    <div data-testid="plugin-homepage-sections">
      <section hidden>Monokai marker</section>
      ${withHeading ? `<section><h2>Start a thread</h2><p>Choose what to work on.</p></section>` : ""}
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

for (const [width, height] of [
  [1440, 900],
  [1920, 1080],
] as const) {
  for (const withHeading of [false, true]) {
    test(`centers the composer at ${width}×${height} ${withHeading ? "with" : "without"} a heading`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.setContent(homeMarkup(false, withHeading));
        await page.addStyleTag({ content: theme });

        const sections = await page.getByTestId("plugin-homepage-sections").boundingBox();
        const composer = await page.getByTestId("root-compose-compact-composer").boundingBox();
        if (!composer || !sections) throw new Error("Missing new-thread layout");
        const composerBottom = composer.y + composer.height;
        const groupStart = withHeading ? sections.y : composer.y;

        expect(groupStart).toBeGreaterThanOrEqual(0);
        expect(composerBottom).toBeLessThanOrEqual(height);
        expect((groupStart + composerBottom) / 2).toBeCloseTo(height / 2, 0);
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

for (const { width, height, topInset } of [
  { width: 390, height: 844, topInset: 47 },
  { width: 440, height: 956, topInset: 62 },
]) {
  for (const insets of [false, true]) {
    for (const keyboard of [false, true]) {
      test(`keeps the phone composer at the bottom at ${width}×${height}, ${insets ? "with" : "without"} insets, keyboard ${keyboard ? "open" : "closed"}`, async () => {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await page.setContent(homeMarkup(true, true, { recentCount: 18 }));
          const bottom = height - (keyboard ? 364 : insets ? 34 : 0);
          const top = insets ? topInset : 0;
          await page.addStyleTag({
            content:
              `
              [data-test-pane] { height: ${bottom}px; padding-top: ${top}px; }
              [data-testid="plugin-homepage-sections"] { margin-top: 24px; }
              [data-promptbox-editor-scroll] { max-height: 72px; overflow-y: auto; }
              ` + theme,
          });
          const composer = page.getByTestId("root-compose-compact-composer");
          await composer.evaluate((element) => {
            element.innerHTML = `
              <div data-promptbox>
                <div data-promptbox-editor-scroll><div contenteditable></div></div>
              </div>`;
          });
          if (keyboard) await composer.locator("[contenteditable]").fill("Draft line\n".repeat(6));
          const recents = page.getByTestId("root-compose-compact-scroll-viewport");
          const box = await composer.boundingBox();
          const list = await recents.boundingBox();
          if (!box || !list) throw new Error("Missing phone composer or recents");
          expect(box.y + box.height).toBe(bottom);
          expect(list.y).toBe(top + 56);
          expect(
            await page
              .getByTestId("plugin-homepage-sections")
              .evaluate((element) => getComputedStyle(element).marginTop),
          ).toBe("0px");
          expect(
            await composer
              .locator("[data-promptbox-editor-scroll]")
              .evaluate((element) => getComputedStyle(element).maxHeight),
          ).toBe("72px");

          await recents.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          expect(await recents.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
          expect(await composer.boundingBox()).toEqual(box);
        } finally {
          await page.close();
        }
      });
    }
  }
}
