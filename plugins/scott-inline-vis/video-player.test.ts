// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { VIDEO_PLAYER_ENTRY_HASH, VIDEO_PLAYER_VERSION } from "./vendor/video-player.ts";
import { loadVideoPlayer, mayNeedVideoPlayer, upgradeVideoPlayers } from "./video-player.ts";

afterEach(() => vi.restoreAllMocks());

const PLAYER = "customElements.define('video-skin', class extends HTMLElement {});";

function upgrade(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  upgradeVideoPlayers(document, PLAYER);
  return document;
}

test("wraps each <video controls> in the Video.js player and skin", () => {
  const document = upgrade(
    `<video id="clip" controls src="clip.mp4" style="--bb-inline-preview-ratio: 16 / 9"></video>
     <video autoplay muted loop src="background.mp4"></video>
     <video-player><video-skin><video controls src="own.mp4"></video></video-skin></video-player>`,
  );
  const [clip, background, own] = document.querySelectorAll("video");
  expect(clip!.parentElement!.localName).toBe("video-skin");
  expect(clip!.parentElement!.parentElement!.localName).toBe("video-player");
  // The skin draws the controls. The native ones come back only if it never defines.
  expect(clip!.hasAttribute("controls")).toBe(false);
  expect(clip!.hasAttribute("data-bb-native-controls")).toBe(true);
  // A video without controls is the author's own design, and an author's player stays as written.
  expect(background!.parentElement!.localName).toBe("body");
  expect(own!.hasAttribute("controls")).toBe(true);
  expect(document.querySelectorAll("video-player")).toHaveLength(2);
  expect(document.querySelector('script[type="module"]')!.textContent).toBe(PLAYER);
  const styles = [...document.head.querySelectorAll("style")].map((style) => style.textContent);
  expect(styles.join("\n")).toContain("--media-border-radius: var(--viz-radius)");
});

test("leaves a video the markup sizes with its native controls", () => {
  // The skin spans its container and zeroes the video's margins.
  const document = upgrade(
    `<video controls width="320" src="a.mp4"></video>
     <video controls style="max-width: 600px; margin: 0 auto" src="b.mp4"></video>`,
  );
  expect(document.querySelector("video-player")).toBeNull();
  expect(document.querySelector('script[type="module"]')).toBeNull();
  expect([...document.querySelectorAll("video")].every((video) => video.controls)).toBe(true);
});

test("a wrapped video stays a carousel variant", () => {
  const document = upgrade(
    `<div class="viz-carousel">
       <video controls data-variant="Before" src="before.mp4"></video>
       <video controls data-variant="After" hidden src="after.mp4"></video>
     </div>`,
  );
  const variants = [...document.querySelector(".viz-carousel")!.children];
  expect(variants.map((variant) => variant.localName)).toEqual(["video-player", "video-player"]);
  expect(variants.map((variant) => variant.getAttribute("data-variant"))).toEqual([
    "Before",
    "After",
  ]);
  expect(variants.map((variant) => variant.hasAttribute("hidden"))).toEqual([false, true]);
  expect(document.querySelector("video[hidden], video[data-variant]")).toBeNull();
});

test("restores native controls when the player never defines", async () => {
  const { JSDOM } = await import("jsdom");
  const document = upgrade('<video controls src="clip.mp4"></video>');
  // jsdom runs no module scripts, as a browser that fails to load the player would not.
  const dom = new JSDOM(document.documentElement.outerHTML, { runScripts: "dangerously" });
  dom.window.dispatchEvent(new dom.window.Event("load"));
  expect(dom.window.document.querySelector("video")!.controls).toBe(true);
  dom.window.close();
});

test("only a fragment that may have a controlled video fetches the player", () => {
  expect(mayNeedVideoPlayer('<video autoplay controls src="a.mp4">')).toBe(true);
  expect(mayNeedVideoPlayer('<video src="a.mp4"></video><p>controls</p>')).toBe(false);
});

test("loads the player once and retries after a failure", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(new Response(PLAYER));
  expect(await loadVideoPlayer("test-player")).toBeUndefined();
  expect(await loadVideoPlayer("test-player")).toBe(PLAYER);
  expect(await loadVideoPlayer("test-player")).toBe(PLAYER);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith("/api/v1/plugins/test-player/http/video-player.js", {
    credentials: "same-origin",
    redirect: "error",
  });
});

test("the vendored player matches its entry and the installed @videojs/html", () => {
  // Run `bun run vendor:player` after changing either.
  const entry = readFileSync(join(import.meta.dirname, "vendor/video-player-entry.ts"), "utf8");
  expect(VIDEO_PLAYER_ENTRY_HASH).toBe(createHash("sha256").update(entry).digest("hex"));
  let directory = dirname(createRequire(import.meta.url).resolve("@videojs/html"));
  while (!directory.endsWith(join("node_modules", "@videojs", "html")))
    directory = dirname(directory);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  expect(VIDEO_PLAYER_VERSION).toBe(manifest.version);
});
