import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { installDom } from "@bb-plugins/testing";
import { chromium, type Browser } from "playwright";
import { mountBbDomStyles } from "../app/bb-dom-styles.ts";
import { FRAME_BORDER_CSS } from "../app/frame-border.ts";

installDom();

const themeCss = await readFile(new URL("../themes/bb-monokai.css", import.meta.url), "utf8");

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

test("mounts one marked stylesheet, hides framed edges, and restores host styles on disposal", () => {
  const hostCss = document.createElement("style");
  hostCss.textContent = `
    [data-sidebar="inset"] {
      padding-inline: 1px;
      padding-bottom: 1px;
    }
    [data-sidebar="inset-edge"] {
      display: block;
      border: 1px solid rgb(57, 57, 58);
    }
  `;
  const fixture = document.createElement("div");
  fixture.innerHTML = `
    <div data-framed="">
      <main data-sidebar="inset"><span data-sidebar="inset-edge"></span></main>
    </div>
    <div data-unframed="">
      <main data-sidebar="inset"><span data-sidebar="inset-edge"></span></main>
    </div>
  `;
  document.head.append(hostCss);
  document.body.append(fixture);

  const framedInset = fixture.querySelector<HTMLElement>('[data-framed] [data-sidebar="inset"]')!;
  const framedEdge = fixture.querySelector<HTMLElement>(
    '[data-framed] [data-sidebar="inset-edge"]',
  )!;
  const unframedInset = fixture.querySelector<HTMLElement>(
    '[data-unframed] [data-sidebar="inset"]',
  )!;
  const unframedEdge = fixture.querySelector<HTMLElement>(
    '[data-unframed] [data-sidebar="inset-edge"]',
  )!;

  const controller = new window.AbortController();
  const selector = "style[data-monokai-bb-dom-styles]";
  try {
    expect(window.getComputedStyle(framedEdge).display).toBe("block");
    expect(window.getComputedStyle(framedInset).getPropertyValue("padding-inline")).toBe("1px");
    expect(window.getComputedStyle(framedInset).paddingBottom).toBe("1px");

    const dispose = mountBbDomStyles({ signal: controller.signal, document });
    try {
      const [style] = document.querySelectorAll(selector);
      expect(document.querySelectorAll(selector)).toHaveLength(1);
      expect(style?.textContent).toContain("[data-t3-model-search]");
      expect(style?.textContent).toContain('[aria-label="Recent"]');
      expect(window.getComputedStyle(framedEdge).display).toBe("none");
      expect(window.getComputedStyle(framedInset).getPropertyValue("padding-inline")).toBe("0");
      expect(window.getComputedStyle(framedInset).paddingBottom).toBe("0px");
      expect(window.getComputedStyle(unframedEdge).display).toBe("block");
      expect(window.getComputedStyle(unframedInset).getPropertyValue("padding-inline")).toBe("1px");
    } finally {
      controller.abort();
      dispose();
    }

    expect(document.querySelector(selector)).toBeNull();
    expect(window.getComputedStyle(framedEdge).display).toBe("block");
    expect(window.getComputedStyle(framedInset).getPropertyValue("padding-inline")).toBe("1px");
    expect(window.getComputedStyle(framedInset).paddingBottom).toBe("1px");
    mountBbDomStyles({ signal: controller.signal, document });
    expect(document.querySelector(selector)).toBeNull();
  } finally {
    hostCss.remove();
    fixture.remove();
  }
});

test("clears framed border, title-bar seam, and 1px reservations in a real browser across palettes", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.setContent(`
      <style>
        @layer utilities {
          :root { --bb-window-title-bar-height: 40px; }
          [data-sidebar="inset"] {
            position: relative;
            padding-inline: 1px;
            padding-bottom: 1px;
          }
          [data-sidebar="inset"]::after {
            content: "";
            position: absolute;
            top: 0;
            left: 0;
            width: 1px;
            height: var(--bb-window-title-bar-height);
            background-color: rgb(57, 57, 58);
          }
          [data-sidebar="inset-edge"] {
            position: absolute;
            inset: var(--bb-window-title-bar-height) 0 0 0;
            border: 1px solid rgb(57, 57, 58);
          }
          aside[data-surface-tone="sidebar"] {
            position: relative;
          }
          aside[data-surface-tone="sidebar"]::before {
            content: "";
            position: absolute;
            inset-inline: 0;
            bottom: 0;
            top: calc(var(--bb-window-title-bar-height) + 1px);
            background-color: rgb(9, 9, 10);
          }
        }
      </style>
      <div data-testid="app-layout-root" data-framed="">
        <main data-sidebar="inset">
          <div data-app-content-shell="">
            <aside data-surface-tone="sidebar"></aside>
          </div>
          <span data-sidebar="inset-edge"></span>
        </main>
      </div>
    `);

    const read = () =>
      page.evaluate(() => {
        const inset = document.querySelector('[data-sidebar="inset"]')!;
        const edge = document.querySelector('[data-sidebar="inset-edge"]')!;
        const panel = document.querySelector('aside[data-surface-tone="sidebar"]')!;
        const insetStyle = getComputedStyle(inset);
        return {
          edgeDisplay: getComputedStyle(edge).display,
          seamDisplay: getComputedStyle(inset, "::after").display,
          paddingLeft: insetStyle.paddingLeft,
          paddingRight: insetStyle.paddingRight,
          paddingBottom: insetStyle.paddingBottom,
          panelBeforeTop: getComputedStyle(panel, "::before").top,
        };
      });

    // Host baseline: all framed border pieces and 1px reservations are active.
    expect(await read()).toEqual({
      edgeDisplay: "block",
      seamDisplay: "block",
      paddingLeft: "1px",
      paddingRight: "1px",
      paddingBottom: "1px",
      panelBeforeTop: "41px",
    });

    // Under Default Light / Default Dark (palette-independent FRAME_BORDER_CSS only):
    const style = await page.addStyleTag({ content: FRAME_BORDER_CSS });
    expect(await read()).toEqual({
      edgeDisplay: "none",
      seamDisplay: "none",
      paddingLeft: "0px",
      paddingRight: "0px",
      paddingBottom: "0px",
      panelBeforeTop: "40px",
    });

    // Removing the injected style restores host defaults.
    await style.evaluate((node) => (node as Element).remove());
    expect(await read()).toEqual({
      edgeDisplay: "block",
      seamDisplay: "block",
      paddingLeft: "1px",
      paddingRight: "1px",
      paddingBottom: "1px",
      panelBeforeTop: "41px",
    });

    // Under bb Monokai dark theme alone (first-paint parity before content scripts):
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.addStyleTag({ content: themeCss });
    expect(await read()).toEqual({
      edgeDisplay: "none",
      seamDisplay: "none",
      paddingLeft: "0px",
      paddingRight: "0px",
      paddingBottom: "0px",
      panelBeforeTop: "40px",
    });
  } finally {
    await page.close();
  }
});

test("does not double-paint New thread halftone at fractional width 767.5px", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  try {
    await page.setContent(
      `<iframe id="frame" style="width: 767.5px; height: 500px; border: 0;"></iframe>`,
    );
    const frame = page.frameLocator("#frame");
    await page.evaluate((css) => {
      const iframe = document.getElementById("frame") as HTMLIFrameElement;
      const doc = iframe.contentDocument!;
      doc.documentElement.classList.add("dark");
      doc.documentElement.setAttribute("data-monokai-home", "");
      doc.head.innerHTML = `<style>${css}</style>`;
      doc.body.innerHTML = `
        <div data-app-content-shell="">
          <div id="root-compose-main-panel"></div>
        </div>
      `;
    }, themeCss);

    const displays = await frame.locator("[data-app-content-shell]").evaluate((shell) => {
      const panel = shell.querySelector("#root-compose-main-panel")!;
      return {
        shellBefore: getComputedStyle(shell, "::before").display,
        shellAfter: getComputedStyle(shell, "::after").display,
        panelBefore: getComputedStyle(panel, "::before").display,
        panelAfter: getComputedStyle(panel, "::after").display,
      };
    });
    expect(displays).toEqual({
      shellBefore: "none",
      shellAfter: "none",
      panelBefore: "block",
      panelAfter: "block",
    });
  } finally {
    await page.close();
  }
});

test("collapses empty sidebar top reserve row only on phones while preserving header slots and narrow fine-pointer windows", async () => {
  const html = `
    <!doctype html>
    <html class="dark">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          :root { --bb-app-chrome-row-height: 3rem; }
          @layer utilities {
            .h-chrome { display: flex; align-items: center; height: var(--bb-app-chrome-row-height); }
            .slot-wrap { display: flex; height: 100%; flex: 1; }
            .slot { display: flex; height: 100%; flex: 1; align-items: center; }
          }
        </style>
        <style>${themeCss}</style>
      </head>
      <body>
        <div data-testid="app-sidebar-top-reserve-row" class="h-chrome">
          <div>
            <button type="button" aria-label="Go back">Back</button>
            <button type="button" aria-label="Go forward">Forward</button>
          </div>
        </div>
        <div data-testid="settings-sidebar-top-reserve-row" class="h-chrome">
          <div class="slot-wrap">
            <div data-sidebar-header-slot="" class="slot">
              <input aria-label="Search settings" style="height: 36px" />
            </div>
          </div>
          <div>
            <button type="button" aria-label="Go back">Back</button>
            <button type="button" aria-label="Go forward">Forward</button>
          </div>
        </div>
      </body>
    </html>
  `;

  const measure = async (opts: {
    viewport: { width: number; height: number };
    isMobile: boolean;
    hasTouch: boolean;
  }) => {
    const context = await browser.newContext(opts);
    const page = await context.newPage();
    try {
      await page.setContent(html);
      return await page.evaluate(() => {
        const emptyRow = document.querySelector('[data-testid="app-sidebar-top-reserve-row"]')!;
        const slotRow = document.querySelector('[data-testid="settings-sidebar-top-reserve-row"]')!;
        const backBtn = emptyRow.querySelector('button[aria-label="Go back"]')!;
        return {
          coarse: matchMedia("(pointer: coarse)").matches,
          emptyHeight: Math.round(emptyRow.getBoundingClientRect().height),
          slotHeight: Math.round(slotRow.getBoundingClientRect().height),
          backDisplay: getComputedStyle(backBtn).display,
        };
      });
    } finally {
      await context.close();
    }
  };

  expect(
    await measure({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true }),
  ).toEqual({
    coarse: true,
    emptyHeight: 0,
    slotHeight: 48,
    backDisplay: "none",
  });

  expect(
    await measure({ viewport: { width: 700, height: 900 }, isMobile: false, hasTouch: false }),
  ).toEqual({
    coarse: false,
    emptyHeight: 48,
    slotHeight: 48,
    backDisplay: "none",
  });

  expect(
    await measure({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false }),
  ).toEqual({
    coarse: false,
    emptyHeight: 48,
    slotHeight: 48,
    backDisplay: "inline-block",
  });
});
