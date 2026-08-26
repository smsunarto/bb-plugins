#!/usr/bin/env bun
/**
 * Render deterministic documentation heroes for selected workspace plugins.
 *
 * The renderer deliberately does not capture a user's live bb session. Live
 * pages contain repository paths, PIDs, clocks, thread activity, and network
 * state, so the same command would produce a different image on every host.
 * Instead, committed UI close-ups are staged over deterministic CSS in one
 * shared 1400×720 scene and captured at DPR 2 with Playwright.
 *
 *   bun run screenshots
 *   bun run screenshots --plugin gh-stack
 *   bun run screenshots --output-dir /tmp/bb-plugin-heroes
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createScreenshotContext,
  createScreenshotPage,
  launchScreenshotBrowser,
  parseScreenshotArguments,
  prepareBbForScreenshots,
  SCREENSHOT_PREFLIGHT_PLUGINS,
  SCREENSHOT_ROOT,
  SCREENSHOT_THEME_ID,
  type ScreenshotOptions,
  withScreenshotBatch,
} from "./plugin-screenshot-runtime";

const ROOT = SCREENSHOT_ROOT;
const VIEWPORT = { width: 1400, height: 720, dpr: 2 } as const;

const SCREENSHOT_FONT_ASSETS = [
  {
    route: "/fonts/inter-latin-variable.woff2",
    path: join(
      ROOT,
      "node_modules",
      "@fontsource-variable",
      "inter",
      "files",
      "inter-latin-wght-normal.woff2",
    ),
  },
  {
    route: "/fonts/ibm-plex-mono-latin-600.woff2",
    path: join(
      ROOT,
      "node_modules",
      "@fontsource",
      "ibm-plex-mono",
      "files",
      "ibm-plex-mono-latin-600-normal.woff2",
    ),
  },
  {
    route: "/fonts/ibm-plex-mono-latin-700.woff2",
    path: join(
      ROOT,
      "node_modules",
      "@fontsource",
      "ibm-plex-mono",
      "files",
      "ibm-plex-mono-latin-700-normal.woff2",
    ),
  },
] as const;

export const SCREENSHOT_EXCLUDED_PLUGINS = ["dotfiles", "notify"] as const;

interface ScreenshotRecipe {
  id: string;
  name: string;
  descriptor: string;
  accent: string;
  glow: string;
  sourceId?: string;
  logoId?: string | null;
  assets: string[];
  content: () => string;
}

function media(plugin: string, filename: string, className: string, alt: string): string {
  return `<img class="${className}" src="/media/${plugin}/${filename}" alt="${alt}" draggable="false" />`;
}

function caption(step: string, text: string): string {
  return `<figcaption><span>${step}</span>${text}</figcaption>`;
}

function callout(className: string, step: string, text: string): string {
  return `<div class="scene-callout ${className}"><span>${step}</span>${text}</div>`;
}

function root(): string {
  return `
    <div class="composition root-composition">
      <figure class="capture root-app">
        ${media("root", "app.png", "capture-image", "The bb app with workspace plugins enabled")}
      </figure>
      <aside class="collection-rail">
        <span>ONE WORKSPACE</span>
        <h2>Every part of<br />the agent loop</h2>
        <div class="collection-row"><i>01</i><b>Agent providers</b></div>
        <div class="collection-row"><i>02</i><b>Dev workflow</b></div>
        <div class="collection-row"><i>03</i><b>Utilities</b></div>
        <div class="collection-row"><i>04</i><b>Theme</b></div>
      </aside>
    </div>`;
}

function agentProxy(): string {
  return `
    <div class="composition proxy-composition">
      <figure class="capture proxy-home">
        ${media("agent-proxy", "home.png", "capture-image", "Agent Proxy core status and local endpoints")}
        ${caption("01", "One endpoint. Always available")}
      </figure>
      <div class="route-line" aria-hidden="true"><i></i><b>route</b><i></i></div>
      <figure class="capture proxy-agents">
        ${media("agent-proxy", "agents.png", "capture-image", "Agent Proxy client wiring controls")}
        ${caption("02", "Wire every coding agent")}
      </figure>
    </div>`;
}

function agentation(): string {
  return `
    <div class="composition agentation-composition">
      <figure class="capture annotation-capture">
        ${media("agentation", "capture.png", "capture-image", "Four selected Copy buttons and an Agentation feedback composer")}
      </figure>
      <figure class="capture annotation-staging">
        ${media("agentation", "staging.png", "capture-image", "One staged annotation ready to send to a bb thread")}
      </figure>
      ${callout("annotation-capture-callout", "01", "Point at the exact UI")}
      ${callout("annotation-staging-callout", "02", "Send context, not a description")}
    </div>`;
}

function amp(): string {
  return `
    <div class="composition amp-composition">
      <figure class="capture amp-prompt">
        ${media("amp", "orb-prompt.png", "capture-image", "A bb composer prompt starting with slash orb")}
      </figure>
      <figure class="capture amp-orb">
        ${media("amp", "orb-bar.png", "capture-image", "An active Amp Orb session with its sync command")}
      </figure>
      <figure class="capture amp-oracle">
        ${media("amp", "oracle-card.png", "capture-image", "An Oracle result card in a bb thread")}
      </figure>
      ${callout("amp-prompt-callout", "01", "Ask for an Orb")}
      ${callout("amp-orb-callout", "02", "Track and sync the sandbox")}
      ${callout("amp-oracle-callout", "03", "Bring in the Oracle")}
    </div>`;
}

function ghStack(): string {
  return `
    <div class="composition stack-composition">
      <figure class="capture stack-open">
        ${media("gh-stack", "new-tab.png", "capture-image", "bb's New tab menu with GitHub Stack selected")}
      </figure>
      <figure class="capture stack-report">
        ${media("gh-stack", "magic-stack-report.png", "capture-image", "An agent report describing a submitted pull request stack")}
      </figure>
      <figure class="capture stack-result">
        ${media("gh-stack", "magic-stack-result.png", "capture-image", "Seven draft pull requests arranged as a stack")}
      </figure>
      ${callout("stack-open-callout", "01", "Open the thread panel")}
      ${callout("stack-report-callout", "02", "Let Magic Stack split the change")}
      ${callout("stack-result-callout", "03", "Review the complete stack")}
    </div>`;
}

function monokai(): string {
  return `
    <div class="composition monokai-composition">
      <figure class="capture monokai-app">
        ${media("monokai", "app.png", "capture-image", "bb with the Monokai palette applied across the app")}
      </figure>
      <div class="palette-rail" aria-label="Monokai semantic colors">
        <span style="--swatch:#88C0D0"><b>INTERACTIVE</b>#88C0D0</span>
        <span style="--swatch:#3FA266"><b>SUCCESS</b>#3FA266</span>
        <span style="--swatch:#F1B467"><b>ATTENTION</b>#F1B467</span>
        <span style="--swatch:#E34671"><b>DANGER</b>#E34671</span>
      </div>
    </div>`;
}

function gtdSidebar(): string {
  return `
    <div class="composition gtd-composition">
      <figure class="capture gtd-sidebar-shot">
        ${media("gtd-sidebar", "sidebar.png", "capture-image", "The GTD Sidebar inbox with waiting, snoozed, and settled threads")}
      </figure>
      <div class="shelf-guide">
        <div class="guide-intro"><span>STABLE BY DESIGN</span><h2>The list moves<br />when you move it</h2></div>
        <div class="guide-row"><i>01</i><div><b>Next Action</b><span>Your turn. Oldest handoff first</span></div><em>empty</em></div>
        <div class="guide-row"><i>02</i><div><b>Waiting</b><span>The agent is working. Oldest wait first</span></div><em>1</em></div>
        <div class="guide-row"><i>03</i><div><b>Snoozed</b><span>Hidden until its wake time or new activity</span></div><em>4</em></div>
        <div class="guide-row"><i>04</i><div><b>Settled</b><span>Archived work, collapsed into one shelf</span></div><em>4</em></div>
      </div>
      <div class="gtd-pointer"><span></span><b>one flat inbox</b></div>
    </div>`;
}

export const ROOT_SCREENSHOT: ScreenshotRecipe = {
  id: "root",
  name: "smsunarto's bb-plugins",
  descriptor: "AGENTS · WORKFLOW · UTILITIES · THEME",
  accent: "#88C0D0",
  glow: "82% 10%",
  sourceId: "monokai",
  logoId: null,
  assets: ["app.png"],
  content: root,
};

export const PLUGIN_SCREENSHOTS: readonly ScreenshotRecipe[] = [
  {
    id: "agent-proxy",
    name: "Agent Proxy",
    descriptor: "POOL · ROUTE · FAIL OVER",
    accent: "#21C991",
    glow: "18% 16%",
    assets: ["home.png", "agents.png"],
    content: agentProxy,
  },
  {
    id: "agentation",
    name: "Agentation",
    descriptor: "POINT · EXPLAIN · SEND",
    accent: "#3FA266",
    glow: "18% 20%",
    assets: ["capture.png", "staging.png"],
    content: agentation,
  },
  {
    id: "amp",
    name: "Amp",
    descriptor: "LOCAL WHEN CLOSE · ORB WHEN FAR",
    accent: "#F25B45",
    glow: "12% 18%",
    assets: ["orb-prompt.png", "orb-bar.png", "oracle-card.png"],
    content: amp,
  },
  {
    id: "gh-stack",
    name: "GitHub Stack",
    descriptor: "ONE CHANGE · REVIEWABLE LAYERS",
    accent: "#A78BFA",
    glow: "50% 14%",
    assets: ["new-tab.png", "magic-stack-report.png", "magic-stack-result.png"],
    content: ghStack,
  },
  {
    id: "gtd-sidebar",
    name: "GTD Sidebar",
    descriptor: "AN INBOX THAT HOLDS STILL",
    accent: "#F1B467",
    glow: "18% 12%",
    assets: ["sidebar.png"],
    content: gtdSidebar,
  },
  {
    id: "monokai",
    name: "bb Monokai",
    descriptor: "ONE HUE · ONE MEANING",
    accent: "#88C0D0",
    glow: "82% 10%",
    assets: ["app.png"],
    content: monokai,
  },
] as const;

const DOCUMENTATION_SCREENSHOTS = [ROOT_SCREENSHOT, ...PLUGIN_SCREENSHOTS] as const;
const recipeById = new Map(DOCUMENTATION_SCREENSHOTS.map((recipe) => [recipe.id, recipe]));

const STYLES = String.raw`
  @font-face { font-family: "Screenshot Inter"; src: url("/fonts/inter-latin-variable.woff2") format("woff2"); font-style: normal; font-weight: 100 900; font-display: block; }
  @font-face { font-family: "Screenshot IBM Plex Mono"; src: url("/fonts/ibm-plex-mono-latin-600.woff2") format("woff2"); font-style: normal; font-weight: 600; font-display: block; }
  @font-face { font-family: "Screenshot IBM Plex Mono"; src: url("/fonts/ibm-plex-mono-latin-700.woff2") format("woff2"); font-style: normal; font-weight: 700; font-display: block; }
  :root { color-scheme: dark; font-family: "Screenshot Inter", sans-serif; }
  * { box-sizing: border-box; }
  html, body { width: 1400px; height: 720px; margin: 0; overflow: hidden; background: #08090a; }
  body { color: #e3e3dd; font-synthesis: none; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
  img { display: block; user-select: none; }
  .stage { --accent: #88c0d0; position: relative; isolation: isolate; width: 1400px; height: 720px; overflow: hidden; background:
    radial-gradient(ellipse 850px 620px at var(--glow), color-mix(in srgb, var(--accent) 15%, transparent), transparent 67%),
    radial-gradient(ellipse 720px 460px at 82% 100%, color-mix(in srgb, var(--accent) 8%, transparent), transparent 72%),
    linear-gradient(145deg, #111416 0%, #08090a 48%, #0a0a0b 100%); }
  .stage::before { content: ""; position: absolute; inset: 0; z-index: -1; opacity: .14; background-image:
    linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px); background-size: 40px 40px; mask-image: linear-gradient(to bottom, black, transparent 76%); }
  .stage::after { content: ""; position: absolute; inset: 0; z-index: 20; pointer-events: none; box-shadow: inset 0 0 120px rgba(0,0,0,.48); }
  .stage-header { position: absolute; z-index: 10; top: 30px; left: 42px; right: 42px; display: flex; align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand img { width: 28px; height: 28px; object-fit: contain; filter: drop-shadow(0 4px 12px color-mix(in srgb, var(--accent) 35%, transparent)); }
  .collection-mark { position: relative; width: 28px; height: 28px; border: 1px solid color-mix(in srgb, var(--accent) 52%, transparent); border-radius: 8px; box-shadow: 0 4px 16px color-mix(in srgb, var(--accent) 18%, transparent); }
  .collection-mark::before, .collection-mark::after { content: ""; position: absolute; width: 8px; height: 8px; border: 1px solid var(--accent); border-radius: 2px; }
  .collection-mark::before { left: 6px; top: 6px; }
  .collection-mark::after { right: 6px; bottom: 6px; background: color-mix(in srgb, var(--accent) 25%, transparent); }
  .brand strong { display: block; font-size: 15px; line-height: 1.1; letter-spacing: -.01em; }
  .brand-copy > span, .stage-index { display: block; margin-top: 4px; color: color-mix(in srgb, var(--accent) 76%, #c8c8c3); font: 700 8px/1.2 "Screenshot IBM Plex Mono", monospace; letter-spacing: .16em; }
  .stage-index { margin: 0; color: rgba(227,227,221,.38); }
  .stage-index b { color: var(--accent); font-weight: 700; }
  .composition { position: absolute; inset: 0; }
  .capture { position: absolute; margin: 0; border: 1px solid rgba(227,227,221,.13); border-radius: 16px; overflow: hidden; background: #141414; box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 7px 20px rgba(0,0,0,.42); }
  .capture::after { content: ""; position: absolute; inset: 0; pointer-events: none; border-radius: inherit; box-shadow: inset 0 1px rgba(255,255,255,.045); }
  .capture-image { width: 100%; height: 100%; object-fit: cover; }
  figcaption, .scene-callout { position: absolute; z-index: 7; display: flex; align-items: center; gap: 9px; padding: 7px 10px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(8,9,10,.82); box-shadow: 0 8px 25px rgba(0,0,0,.4); backdrop-filter: blur(14px); color: rgba(227,227,221,.88); font-size: 11px; font-weight: 650; }
  figcaption { left: 18px; bottom: 14px; }
  figcaption span, .scene-callout span { color: var(--accent); font: 700 8px/1 "Screenshot IBM Plex Mono", monospace; letter-spacing: .12em; }

  .root-app { left: 128px; top: 80px; width: 907px; height: 600px; }.root-app .capture-image { object-fit: contain; }
  .collection-rail { position: absolute; z-index: 6; right: 54px; top: 178px; width: 252px; }
  .collection-rail > span { color: var(--accent); font: 700 8px/1 "Screenshot IBM Plex Mono", monospace; letter-spacing: .17em; }
  .collection-rail h2 { margin: 10px 0 24px; color: #e3e3dd; font-size: 27px; line-height: 1.06; letter-spacing: -.04em; }
  .collection-row { display: grid; grid-template-columns: 31px 1fr; align-items: center; padding: 13px 4px; border-top: 1px solid rgba(227,227,221,.12); }
  .collection-row i { color: var(--accent); font: 700 8px/1 "Screenshot IBM Plex Mono", monospace; font-style: normal; }
  .collection-row b { color: rgba(227,227,221,.72); font-size: 11px; font-weight: 650; }

  .proxy-home { left: 68px; top: 92px; width: 604px; height: 507px; }
  .proxy-agents { right: 68px; top: 124px; width: 604px; height: 507px; }
  .route-line { position: absolute; left: 658px; top: 332px; z-index: 4; display: flex; align-items: center; gap: 5px; color: var(--accent); transform: rotate(-4deg); }
  .route-line i { width: 18px; height: 1px; background: currentColor; opacity: .6; }
  .route-line b { padding: 5px 7px; border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 999px; background: #0b100f; font: 700 7px/1 "Screenshot IBM Plex Mono", monospace; letter-spacing: .12em; text-transform: uppercase; }

  .annotation-capture { left: 108px; top: 79px; width: 724px; height: 390px; }
  .annotation-staging { right: 94px; bottom: 61px; z-index: 4; width: 710px; height: 270px; }
  .annotation-capture-callout { left: 126px; top: 480px; }
  .annotation-staging-callout { right: 112px; bottom: 22px; }
  .amp-prompt { left: 60px; top: 92px; width: 699px; height: 192px; }
  .amp-orb { left: 793px; top: 92px; width: 547px; height: 192px; }
  .amp-oracle { left: 265px; top: 350px; width: 870px; height: 314px; }
  .amp-prompt .capture-image, .amp-orb .capture-image, .amp-oracle .capture-image { object-fit: contain; object-position: center; }
  .amp-prompt-callout { left: 60px; top: 298px; }
  .amp-orb-callout { left: 793px; top: 298px; }
  .amp-oracle-callout { left: 265px; top: 677px; }

  .stack-open { left: 38px; top: 200px; width: 496px; height: 300px; }.stack-report { left: 558px; top: 190px; width: 480px; height: 320px; }.stack-result { left: 1062px; top: 100px; width: 298px; height: 500px; }
  .stack-open .capture-image, .stack-report .capture-image { object-position: top; }.stack-result .capture-image { object-fit: contain; object-position: top; }
  .stack-open-callout, .stack-report-callout, .stack-result-callout { top: 626px; white-space: nowrap; transform: translateX(-50%); }
  .stack-open-callout { left: 286px; }.stack-report-callout { left: 798px; }.stack-result-callout { left: 1211px; }

  .monokai-app { left: 188px; top: 80px; width: 907px; height: 600px; }.monokai-app .capture-image { object-fit: contain; }
  .palette-rail { position: absolute; z-index: 6; right: 52px; top: 188px; display: grid; gap: 7px; }.palette-rail span { display: grid; grid-template-columns: 8px 74px 62px; align-items: center; gap: 7px; padding: 7px 9px; border: 1px solid rgba(255,255,255,.08); border-radius: 7px; background: rgba(10,10,11,.82); color: rgba(227,227,221,.55); font: 600 7px/1 "Screenshot IBM Plex Mono", monospace; backdrop-filter: blur(12px); }.palette-rail span::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--swatch); box-shadow: 0 0 14px color-mix(in srgb, var(--swatch) 45%, transparent); }.palette-rail b { color: rgba(227,227,221,.86); font-size: 7px; letter-spacing: .08em; }

  .gtd-sidebar-shot { left: 240px; top: 53px; width: 202px; height: 632px; border-radius: 15px; }.gtd-sidebar-shot .capture-image { object-position: top; }
  .shelf-guide { position: absolute; left: 540px; top: 118px; width: 660px; }.guide-intro { margin-bottom: 28px; }.guide-intro span { color: var(--accent); font: 700 8px/1 "Screenshot IBM Plex Mono", monospace; letter-spacing: .17em; }.guide-intro h2 { margin: 9px 0 0; color: #e3e3dd; font-size: 34px; line-height: 1.04; letter-spacing: -.04em; }
  .guide-row { display: grid; grid-template-columns: 40px 1fr auto; gap: 15px; align-items: center; padding: 17px 6px; border-top: 1px solid rgba(227,227,221,.12); }.guide-row > i { color: var(--accent); font: 700 9px/1 "Screenshot IBM Plex Mono", monospace; font-style: normal; }.guide-row div { display: grid; gap: 5px; }.guide-row b { font-size: 13px; }.guide-row span { color: rgba(227,227,221,.49); font-size: 10px; }.guide-row em { min-width: 45px; padding: 6px 9px; border: 1px solid rgba(255,255,255,.09); border-radius: 999px; color: rgba(227,227,221,.58); font: 600 8px/1 "Screenshot IBM Plex Mono", monospace; font-style: normal; text-align: center; }.gtd-pointer { position: absolute; left: 416px; top: 232px; display: flex; align-items: center; color: var(--accent); transform: rotate(-7deg); }.gtd-pointer span { width: 92px; border-top: 1px dashed color-mix(in srgb, var(--accent) 55%, transparent); }.gtd-pointer b { margin-left: 7px; font: 700 7px/1 "Screenshot IBM Plex Mono", monospace; letter-spacing: .12em; text-transform: uppercase; }

  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } }
`;

export function stageDocument(recipe: ScreenshotRecipe): string {
  const pluginIndex = PLUGIN_SCREENSHOTS.findIndex((candidate) => candidate.id === recipe.id);
  const index = pluginIndex === -1 ? "ALL" : String(pluginIndex + 1).padStart(2, "0");
  const mark =
    recipe.logoId === null
      ? '<span class="collection-mark" aria-hidden="true"></span>'
      : `<img src="/logo/${recipe.id}" alt="" />`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${recipe.name} documentation hero</title>
  <style>${STYLES}</style>
</head>
<body>
  <main class="stage" style="--accent:${recipe.accent};--glow:${recipe.glow}" data-plugin="${recipe.id}">
    <header class="stage-header">
      <div class="brand">${mark}<div class="brand-copy"><strong>${recipe.name}</strong><span>${recipe.descriptor}</span></div></div>
      <div class="stage-index">BB PLUGINS / <b>${index}</b></div>
    </header>
    ${recipe.content()}
  </main>
  <script>
    window.__SCREENSHOT_READY__ = false;
    Promise.all([
      ...Array.from(document.images, image => image.decode()),
      document.fonts.load('400 16px "Screenshot Inter"'),
      document.fonts.load('600 16px "Screenshot IBM Plex Mono"'),
      document.fonts.load('700 16px "Screenshot IBM Plex Mono"'),
    ])
      .then(() => document.fonts.ready)
      .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      .then(() => { window.__SCREENSHOT_READY__ = true; });
  </script>
</body>
</html>`;
}

function usage(): string {
  return `Capture deterministic, staged hero screenshots for bb plugins.

Usage:
  bun run screenshots [options]

Options:
  --plugin <id>       Capture one hero. Repeat to capture several.
  --output-dir <path> Write <id>.png there instead of docs/media/hero.png.
  --list              Print supported plugin ids.
  --help              Show this help.

Output: ${VIEWPORT.width * VIEWPORT.dpr}×${VIEWPORT.height * VIEWPORT.dpr} PNG at DPR ${VIEWPORT.dpr}.`;
}

function validateRecipes(): void {
  const workspaceIds = new Set(SCREENSHOT_PREFLIGHT_PLUGINS.map((plugin) => plugin.id));
  const stale = PLUGIN_SCREENSHOTS.map((recipe) => recipe.id).filter((id) => !workspaceIds.has(id));
  if (stale.length) {
    throw new Error(`recipes without workspace plugins: ${stale.join(", ")}`);
  }
  for (const recipe of DOCUMENTATION_SCREENSHOTS) {
    const sourceId = recipe.sourceId ?? recipe.id;
    if (recipe.logoId !== null) {
      const logo = join(ROOT, "plugins", recipe.logoId ?? recipe.id, "assets", "logo-dark.svg");
      if (!existsSync(logo)) throw new Error(`missing screenshot logo: ${relative(ROOT, logo)}`);
    }
    for (const asset of recipe.assets) {
      const path = join(ROOT, "plugins", sourceId, "docs", "media", asset);
      if (!existsSync(path)) throw new Error(`missing screenshot source: ${relative(ROOT, path)}`);
    }
  }
  for (const font of SCREENSHOT_FONT_ASSETS) {
    if (!existsSync(font.path)) {
      throw new Error(`missing screenshot font: ${relative(ROOT, font.path)} (run bun install)`);
    }
  }
}

function screenshotPath(recipe: ScreenshotRecipe, outputDir: string | null): string {
  if (outputDir) {
    const directory = isAbsolute(outputDir) ? outputDir : resolve(ROOT, outputDir);
    return join(directory, `${recipe.id}.png`);
  }
  if (recipe.id === ROOT_SCREENSHOT.id) {
    return join(ROOT, "docs", "media", "hero.png");
  }
  return join(ROOT, "plugins", recipe.id, "docs", "media", "hero.png");
}

async function main(): Promise<void> {
  let options: ScreenshotOptions;
  try {
    options = parseScreenshotArguments(process.argv.slice(2));
  } catch (error) {
    console.error(
      `plugin-screenshots: ${error instanceof Error ? error.message : String(error)}\n\n${usage()}`,
    );
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.list) {
    console.log(DOCUMENTATION_SCREENSHOTS.map((recipe) => recipe.id).join("\n"));
    return;
  }

  validateRecipes();
  const requested = options.plugins.length
    ? options.plugins
    : DOCUMENTATION_SCREENSHOTS.map((recipe) => recipe.id);
  const unknown = requested.filter((id) => !recipeById.has(id));
  if (unknown.length)
    throw new Error(`unknown plugin${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  const recipes = requested.map((id) => recipeById.get(id)!);

  await prepareBbForScreenshots();
  console.log(
    `bb preflight    ${SCREENSHOT_PREFLIGHT_PLUGINS.length} workspace plugins enabled · ${SCREENSHOT_THEME_ID}`,
  );

  const routes = new Map<string, string>();
  for (const font of SCREENSHOT_FONT_ASSETS) {
    routes.set(font.route, font.path);
  }
  for (const recipe of DOCUMENTATION_SCREENSHOTS) {
    const sourceId = recipe.sourceId ?? recipe.id;
    if (recipe.logoId !== null) {
      routes.set(
        `/logo/${recipe.id}`,
        join(ROOT, "plugins", recipe.logoId ?? recipe.id, "assets", "logo-dark.svg"),
      );
    }
    for (const asset of recipe.assets) {
      routes.set(
        `/media/${recipe.id}/${asset}`,
        join(ROOT, "plugins", sourceId, "docs", "media", asset),
      );
    }
  }
  const results = await withScreenshotBatch(async (batch) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const assetPath = routes.get(url.pathname);
        if (assetPath) return new Response(Bun.file(assetPath));
        if (url.pathname !== "/") return new Response("Not found", { status: 404 });
        const recipe = recipeById.get(url.searchParams.get("plugin") ?? "");
        if (!recipe) return new Response("Unknown plugin", { status: 404 });
        return new Response(stageDocument(recipe), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      },
    });
    try {
      const browser = await launchScreenshotBrowser();
      try {
        const context = await createScreenshotContext(browser, {
          viewport: VIEWPORT,
          dpr: VIEWPORT.dpr,
        });
        try {
          const page = await createScreenshotPage(context, { timeoutMs: 10_000 });
          for (const recipe of recipes) {
            const url = `http://${server.hostname}:${server.port}/?plugin=${encodeURIComponent(recipe.id)}`;
            await page.goto(url, { waitUntil: "load" });
            await page.waitForFunction(() => Reflect.get(window, "__SCREENSHOT_READY__") === true);
            const undersized = await page.locator(".capture img").evaluateAll(
              (images, dpr) =>
                images.flatMap((image) => {
                  if (!(image instanceof HTMLImageElement)) return [];
                  const box = image.getBoundingClientRect();
                  const required = {
                    width: Math.ceil(box.width * dpr),
                    height: Math.ceil(box.height * dpr),
                  };
                  return image.naturalWidth < required.width ||
                    image.naturalHeight < required.height
                    ? [
                        {
                          source: new URL(image.src).pathname,
                          actual: `${image.naturalWidth}×${image.naturalHeight}`,
                          required: `${required.width}×${required.height}`,
                        },
                      ]
                    : [];
                }),
              VIEWPORT.dpr,
            );
            if (undersized.length > 0) {
              throw new Error(
                [
                  `${recipe.id} has foreground sources below final DPR ${VIEWPORT.dpr}:`,
                  ...undersized.map(
                    ({ source, actual, required }) =>
                      `  ${source}: ${actual}; needs at least ${required}`,
                  ),
                  "Run bun run screenshots:fixtures, then try again.",
                ].join("\n"),
              );
            }
            await batch.capture(page, {
              id: recipe.id,
              output: screenshotPath(recipe, options.outputDir),
              expected: {
                width: VIEWPORT.width * VIEWPORT.dpr,
                height: VIEWPORT.height * VIEWPORT.dpr,
              },
            });
          }
        } finally {
          await context.close();
        }
      } finally {
        await browser.close();
      }
    } finally {
      server.stop(true);
    }
  });
  for (const result of results) {
    console.log(
      `${result.id.padEnd(15)} ${relative(ROOT, result.output)}  ${result.width}×${result.height}`,
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`plugin-screenshots: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
