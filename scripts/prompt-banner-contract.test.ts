import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { stripComments } from "./style-contract";

/**
 * Guard against prompt-stack banner style drift (BBP-135).
 *
 * Prompt-stack banners live above the composer beside bb's own cards. They
 * stay visually identical only when:
 * 1. Every plugin banner card uses bb's host chrome (`chrome: "card"` / default)
 *    instead of hand-copying `PromptStackCard` frames or hairlines.
 * 2. Theme and plugin CSS restyles prompt-stack cards through one shared
 *    selector/token, never targeting individual cards by id or aria-label.
 * 3. `t3-composer`'s unified prompt-stack stylesheet owns the hairline and
 *    active-row normalization for all prompt-stack cards without utility
 *    anchors or per-card selectors.
 */

/** Non-card or non-visual composer banners that legitimately use `chrome: "bare"`. */
const BARE_BANNER_ALLOWLIST = new Set<string>([
  // Non-visual haptic listener; returns null and renders no card.
  "plugins/kitchen-sink/src/app/app.tsx:send-haptic",
  // Standalone rounded-full toggle pill on new-thread composer, not a banner card.
  "plugins/devin/src/app/app.tsx:cloud-toggle",
]);

/** Single-card prompt-banner selectors that must never appear in plugin or theme CSS. */
const SINGLE_CARD_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "thread-prompt-banner id selector", pattern: /thread-prompt-banner-/g },
  {
    name: "per-card prompt banner aria-label selector",
    pattern:
      /\[aria-label="(?:Thread context before sending|Child threads|Background agents|Background commands|To-do list|Workflow|Workflows|Model fallback|Machine status|Queued messages|Thread history|Plan|Goal)"\]/g,
  },
  {
    name: "single-plugin staging banner selector",
    pattern: /\[data-agentation-staging-banner\]/g,
  },
];

function trackedPluginFiles(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "plugins"],
    {
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(
      (file) =>
        Boolean(file) &&
        existsSync(file) &&
        !file.includes("/dist/") &&
        !file.includes("/node_modules/") &&
        !file.includes("/test/") &&
        !/\.(?:test|spec|stories|d)\.tsx?$/.test(file) &&
        /\.(?:tsx?|css)$/.test(file),
    );
}

describe("prompt-stack banner contract", () => {
  test("every visual plugin composer banner card uses host chrome (never chrome: 'bare')", () => {
    const violations: string[] = [];
    for (const file of trackedPluginFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const source = stripComments(readFileSync(file, "utf8"), file);
      if (!source.includes("banners")) continue;
      for (const match of source.matchAll(/banners\s*:\s*\[([\s\S]*?)\]/g)) {
        const block = match[1]!;
        for (const entry of block.matchAll(/\{([^{}]*)\}/g)) {
          const body = entry[1]!;
          if (!/chrome\s*:\s*["']bare["']/.test(body)) continue;
          const id = /id\s*:\s*["']([^"']+)["']/.exec(body)?.[1] ?? "<unknown>";
          const key = `${file}:${id}`;
          if (!BARE_BANNER_ALLOWLIST.has(key)) {
            violations.push(
              `${key} registers chrome: "bare"; use host chrome ("card" or omitted) so the banner shares bb's PromptStackCard chrome.`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("plugin banner components do not hand-copy PromptStackCard hairlines or active-row washes", () => {
    const bannerFiles = [
      "plugins/captain/src/app/banner.tsx",
      "plugins/devin/src/app/app.tsx",
      "plugins/source-control/src/app/pr-watch-banner.tsx",
      "plugins/kitchen-sink/src/app/rpiv-todo/banner.tsx",
    ];
    const violations: string[] = [];
    for (const file of bannerFiles) {
      if (!existsSync(file)) continue;
      const source = stripComments(readFileSync(file, "utf8"), file);
      if (/\bsurface\.hairline\b/.test(source)) {
        violations.push(
          `${file} uses surface.hairline; let host PromptStackCard own the card edge.`,
        );
      }
      if (/\bbg-background\/70\b/.test(source)) {
        violations.push(
          `${file} paints bg-background/70 inside a prompt banner; let host PromptStackCard own the card fill.`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test("no plugin or theme stylesheet targets an individual prompt-stack banner card", () => {
    const violations: string[] = [];
    for (const file of trackedPluginFiles()) {
      if (!file.endsWith(".css") && !file.endsWith(".ts")) continue;
      if (file.endsWith("/scripts/audit-theme-surfaces.ts")) continue;
      const raw = readFileSync(file, "utf8");
      const source = stripComments(raw, file);
      const lines = raw.split("\n");
      for (const { name, pattern } of SINGLE_CARD_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index!).split("\n").length;
          violations.push(`${file}:${line} (${name}): ${lines[line - 1]?.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("t3-composer unifies all prompt-stack banner cards through one stylesheet without utility anchors", async () => {
    const modulePath = "plugins/t3-composer/src/prompt-stack-banner-style.ts";
    expect(existsSync(modulePath)).toBe(true);
    expect(existsSync("plugins/t3-composer/src/child-threads-banner-style.ts")).toBe(false);

    const mod = await import(`../${modulePath}`);
    const css: string = mod.PROMPT_STACK_BANNER_CSS;

    // Must never anchor on Tailwind utility classes or individual banner IDs/labels.
    expect(css).not.toMatch(/\.rounded-lg|\.border-border|\.ring-1|\.bg-background/);
    expect(css).not.toMatch(/thread-prompt-banner-|aria-label="/);
    // Hairline must draw via ::after so child fills never wash it out.
    expect(css).toContain("::after");
    // Must normalize active-row washes/rings and disclosure dividers uniformly.
    expect(css).toContain("background-color: transparent");
    expect(css).toContain('section[aria-hidden="false"]::before');
    expect(css).toContain('section[aria-hidden="true"]');

    // t3-composer/app.css must not carry duplicate utility-anchored banner card rules.
    const appCss = stripComments(readFileSync("plugins/t3-composer/app.css", "utf8"), "app.css");
    expect(appCss).not.toContain("section.rounded-lg.border-border");
    expect(appCss).not.toContain("section.rounded-b-none.border-border");
  });
});
