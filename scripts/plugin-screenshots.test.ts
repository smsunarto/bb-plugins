import { describe, expect, test } from "bun:test";
import { workspacePlugins } from "./plugin-package";
import {
  PLUGIN_SCREENSHOTS,
  ROOT_SCREENSHOT,
  SCREENSHOT_EXCLUDED_PLUGINS,
  stageDocument,
} from "./plugin-screenshots";
import {
  SCREENSHOT_PREFLIGHT_PLUGINS,
} from "./plugin-screenshot-runtime";

const ROOT = new URL("..", import.meta.url).pathname;

describe("plugin screenshot recipes", () => {
  test("cover the approved plugin heroes exactly once", () => {
    const recipeIds = PLUGIN_SCREENSHOTS.map((recipe) => recipe.id);

    expect([...SCREENSHOT_EXCLUDED_PLUGINS]).toEqual([
      "dotfiles",
      "notify",
      "pr-walkthrough",
    ]);
    expect(recipeIds).toEqual([
      "agent-proxy",
      "agentation",
      "amp",
      "gh-stack",
      "gtd-sidebar",
      "monokai",
    ]);
    expect(new Set(recipeIds).size).toBe(recipeIds.length);
  });

  test("preflights every workspace plugin, including hero exclusions", () => {
    const workspaceIds = workspacePlugins(ROOT).map((plugin) => plugin.id);
    const preflightIds = SCREENSHOT_PREFLIGHT_PLUGINS.map((plugin) => plugin.id);

    expect(preflightIds).toEqual(workspaceIds);
    for (const id of SCREENSHOT_EXCLUDED_PLUGINS) {
      expect(preflightIds).toContain(id);
    }
  });

  test("produce fixed stages with an explicit readiness signal", () => {
    const captions: string[] = [];
    for (const recipe of [ROOT_SCREENSHOT, ...PLUGIN_SCREENSHOTS]) {
      const document = stageDocument(recipe);
      expect(document).toContain('width: 1400px; height: 720px');
      expect(document).toContain(`data-plugin="${recipe.id}"`);
      expect(document).toContain('font-family: "Screenshot Inter"');
      expect(document).toContain('font-family: "Screenshot IBM Plex Mono"');
      expect(document).toContain(
        'document.fonts.load(\'400 16px "Screenshot Inter"\')',
      );
      expect(document).toContain(
        'document.fonts.load(\'600 16px "Screenshot IBM Plex Mono"\')',
      );
      expect(document).toContain(
        'document.fonts.load(\'700 16px "Screenshot IBM Plex Mono"\')',
      );
      expect(document).toContain("window.__SCREENSHOT_READY__ = true");
      expect(document).not.toMatch(/Date\(|Date\.now|Math\.random/);
      captions.push(...[...document.matchAll(
        /<(?:figcaption|div class="scene-callout[^"]*")><span>\d+<\/span>([^<]+)<\/(?:figcaption|div)>/g,
      )].flatMap((match) => match[1] ?? []));
    }
    expect(captions.length).toBeGreaterThan(0);
    expect(captions.every((text) => !text.endsWith("."))).toBe(true);
  });

  test("stages the root hero from the deterministic full-app capture", () => {
    const document = stageDocument(ROOT_SCREENSHOT);

    expect(ROOT_SCREENSHOT).toMatchObject({
      id: "root",
      sourceId: "monokai",
      logoId: null,
      assets: ["app.png"],
    });
    expect(document.match(/<figure class="capture/g)).toHaveLength(1);
    expect(document).toContain('src="/media/root/app.png"');
    expect(document).toContain('class="collection-mark"');
    expect(document).toContain("BB PLUGINS / <b>ALL</b>");
    expect(document).toContain(
      ".root-app .capture-image { object-fit: contain; }",
    );
  });

  test("uses one production screenshot in the Monokai hero", () => {
    const recipe = PLUGIN_SCREENSHOTS.find((candidate) => candidate.id === "monokai")!;
    const document = stageDocument(recipe);

    expect(recipe.assets).toEqual(["app.png"]);
    expect(document.match(/<figure class="capture/g)).toHaveLength(1);
    expect(document).toContain(
      ".monokai-app .capture-image { object-fit: contain; }",
    );
  });
});
