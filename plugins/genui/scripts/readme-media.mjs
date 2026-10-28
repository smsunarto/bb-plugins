// Builds the README's carousel, docs/media/carousel.webp: each slide is one
// gallery example as BB renders it (the plugin installed and running), framed
// on a plain background with its name, light or dark. Animated examples (3D
// scenes and shaders) are captured as a short run of frames, so the carousel
// shows them moving. Needs a running BB with this plugin loaded, and img2webp
// (`brew install webp`).
//
//   node scripts/readme-media.mjs [--url http://127.0.0.1:38886] [--keep /tmp/slides]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const base = option("--url") ?? process.env.BB_URL ?? "http://127.0.0.1:38886";
const keep = option("--keep");

/**
 * Gallery example, theme, caption, and for animated examples how many frames
 * to capture. Order is the carousel's.
 */
const SLIDES = [
  ["Scene-animated", "dark", "Scene · real 3D, animated: t => [...]", 28],
  ["Chart-funnel", "light", "Chart · funnel"],
  ["Diagram", "dark", "Diagram · click a part to read about it"],
  ["Scene-glass", "light", "Scene · glass that refracts and disperses light"],
  ["Map", "light", "Map · places looked up and routed"],
  ["Decision", "light", "Decision · you tune the weights"],
  ["Shader-buffers", "dark", "Shader · Shadertoy GLSL with feedback buffers", 28],
  ["Board", "dark", "Board · bb tasks or GitHub issues"],
  ["Roadmap", "light", "Roadmap"],
  ["Scene-model", "light", "Scene · glTF models lit by an HDR"],
  ["Transcript", "light", "Transcript · aligned word by word, with WER"],
  ["Compare", "dark", "Compare · wipe, blink or pixel difference"],
  ["Findings", "light", "Findings · ESLint, tsc, SARIF or a review"],
  ["Shader", "dark", "Shader · raymarched, drag to orbit", 20],
  ["Tests", "dark", "Tests · a vitest, jest or JUnit report"],
  ["Quiz", "light", "Quiz"],
  ["Entity-list", "light", "Entity · places and products"],
];
const SLIDE_MS = 2600;
/** Longest gap kept between two captured frames of an animated slide (capture can stall). */
const MAX_FRAME_MS = 160;
/** CSS pixels of a slide; captured at 2x. */
const SLIDE = { width: 800, height: 500 };
const THEMES = {
  light: { page: "#f4f4f2", caption: "#6b6b68" },
  dark: { page: "#151515", caption: "#9a9a96" },
};

const work = keep ?? mkdtempSync(path.join(tmpdir(), "genui-slides-"));
mkdirSync(work, { recursive: true });
const browser = await chromium.launch();
/** Each frame file and how long it shows. */
const frames = [];
try {
  const slide = await browser.newContext({ viewport: SLIDE, deviceScaleFactor: 2 });
  const canvas = await slide.newPage();
  /** Frames one example on the slide background with its caption, as a PNG file. */
  const compose = async (shot, theme, caption, name) => {
    const { page: background, caption: ink } = THEMES[theme];
    await canvas.setContent(`<!doctype html><html><body style="margin:0;width:${SLIDE.width}px;height:${SLIDE.height}px;background:${background};display:flex;flex-direction:column;font-family:-apple-system,'SF Pro Text','Inter',system-ui,sans-serif">
      <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:28px 40px 8px">
        <img src="data:image/png;base64,${shot.toString("base64")}" style="max-width:100%;max-height:100%;object-fit:contain">
      </div>
      <p style="margin:0;padding:0 40px 22px;font-size:13px;letter-spacing:.01em;color:${ink}">${caption}</p>
    </body></html>`);
    await canvas.waitForFunction(() => document.images[0]?.complete);
    const file = path.join(work, `${name}.png`);
    await canvas.screenshot({ path: file });
    return file;
  };
  for (const [index, [example, theme, caption, count = 1]] of SLIDES.entries()) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 1200 }, deviceScaleFactor: 2, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(`${base}/plugins/genui/gallery/${encodeURIComponent(example)}`, { waitUntil: "domcontentloaded" });
    const entry = page.locator(`[data-gallery-entry="${example}"]`);
    const ui = entry.locator(".group\\/genui > :first-child").first();
    await ui.waitFor({ timeout: 30_000 });
    // Images, map tiles, diagrams, 3D assets and entrances settle.
    await page.waitForTimeout(3500);
    await page.evaluate(() => {
      const gallery = document.querySelector("[data-gallery-entry]")?.closest("[class*=overflow-y-auto]");
      for (const element of document.querySelectorAll("body *")) {
        const { position } = getComputedStyle(element);
        // Floating windows from other plugins, and the gallery's own sticky header, would cover the example.
        const floating = position === "fixed" && gallery != null && !element.contains(gallery) && !gallery.contains(element);
        const header = position === "sticky" && gallery?.contains(element);
        if (floating || header) element.style.visibility = "hidden";
      }
    });
    await ui.scrollIntoViewIfNeeded();
    // Animated examples keep running while they are captured; each frame shows for the time
    // that really passed before the next, so the carousel plays them at their own speed.
    const shots = [];
    for (let frame = 0; frame < count; frame++) shots.push({ at: Date.now(), shot: await ui.screenshot() });
    await context.close();

    for (const [frame, { at, shot }] of shots.entries()) {
      const name = `${String(index + 1).padStart(2, "0")}-${example}-${String(frame).padStart(3, "0")}`;
      const last = frame === shots.length - 1;
      const gap = last ? 0 : Math.min(MAX_FRAME_MS, shots[frame + 1].at - at);
      // A still slide shows for SLIDE_MS; an animated one for its frames, then holds its last frame briefly.
      const duration = count === 1 ? SLIDE_MS : last ? 600 : gap;
      frames.push({ file: await compose(shot, theme, caption, name), duration });
    }
    console.log(`slide ${index + 1}/${SLIDES.length}: ${example} (${theme}${count > 1 ? `, ${count} frames` : ""})`);
  }
  await slide.close();
} finally {
  await browser.close();
}

const out = path.join(root, "docs", "media", "carousel.webp");
mkdirSync(path.dirname(out), { recursive: true });
execFileSync(
  "img2webp",
  ["-loop", "0", "-lossy", "-q", "80", "-m", "6", ...frames.flatMap(({ file, duration }) => ["-d", String(duration), file]), "-o", out],
  { stdio: "inherit" },
);
console.log(`${path.relative(root, out)}: ${(statSync(out).size / 1024).toFixed(0)} KB, ${SLIDES.length} slides, ${frames.length} frames`);
if (keep === undefined) rmSync(work, { recursive: true, force: true });
