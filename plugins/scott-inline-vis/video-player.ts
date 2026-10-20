import { videoPlayerUrl } from "./preview-frame.ts";

/**
 * A fragment's `<video controls>` plays in the Video.js player and skin: the
 * same controls, hotkeys, speed menu, fullscreen, and picture-in-picture in
 * every browser, at bb's corner radius. It wraps the author's `<video>`, so
 * the asset bridge and the author's styles still reach that element. Full
 * HTML documents keep the author's own player.
 */
// The skin's controls stay dark in both color schemes, so it keeps its own
// accent; bb's primary is near black in light themes.
const PLAYER_STYLE = `:where(video-player, video-skin) { display: block; }
:where(video-skin) {
  --media-border-radius: var(--viz-radius);
  --media-font-family: var(--font-sans);
}`;
const NATIVE_CONTROLS_ATTRIBUTE = "data-bb-native-controls";
// The skin replaces the native controls. Restore them if the player never defines.
const NATIVE_CONTROLS_FALLBACK = `addEventListener("load", () => {
  if (customElements.get("video-skin")) return;
  for (const video of document.querySelectorAll("video[${NATIVE_CONTROLS_ATTRIBUTE}]")) video.controls = true;
});`;

/**
 * The skin spans its container and zeroes the video's margins, so a video
 * the markup sizes or positions itself keeps its native controls.
 */
const playerVideos = (document: Document) =>
  [...document.querySelectorAll("video[controls]")].filter(
    (video) =>
      !video.closest("video-player, video-skin") &&
      !video.hasAttribute("width") &&
      !video.hasAttribute("height") &&
      // The box hold's ratio property is the asset loader's, not the author's.
      !(video.getAttribute("style") ?? "").replace(/--bb-inline-preview-ratio:[^;]*;?/u, "").trim(),
  );

/** Whether `html` may need the player, before parsing it. */
export const mayNeedVideoPlayer = (html: string) => /<video\b[^>]*\scontrols\b/iu.test(html);

export function upgradeVideoPlayers(document: Document, source: string) {
  const videos = playerVideos(document);
  if (videos.length === 0) return;
  for (const video of videos) {
    const player = document.createElement("video-player");
    const skin = document.createElement("video-skin");
    video.replaceWith(player);
    player.append(skin);
    skin.append(video);
    // The runtime finds carousel variants among a carousel's own children and
    // shows one at a time, so the player takes over that role.
    for (const name of ["data-variant", "hidden"]) {
      const value = video.getAttribute(name);
      if (value === null) continue;
      player.setAttribute(name, value);
      video.removeAttribute(name);
    }
    video.removeAttribute("controls");
    video.setAttribute(NATIVE_CONTROLS_ATTRIBUTE, "");
  }
  const style = document.createElement("style");
  style.textContent = PLAYER_STYLE;
  const fallback = document.createElement("script");
  fallback.textContent = NATIVE_CONTROLS_FALLBACK;
  const module = document.createElement("script");
  module.type = "module";
  // Serialized script text is not escaped, so no "</script" may close the element early.
  module.textContent = source.replaceAll("</script", "<\\/script");
  document.head.prepend(style);
  document.head.append(fallback, module);
}

// The bundle is half a megabyte, so the app fetches it from the plugin server
// only when a preview needs it, once per page.
const loads = new Map<string, Promise<string | undefined>>();

/** The player bundle, or undefined if it cannot load; videos then keep native controls. */
export function loadVideoPlayer(pluginId: string): Promise<string | undefined> {
  let load = loads.get(pluginId);
  if (!load) {
    load = fetch(videoPlayerUrl(pluginId), { credentials: "same-origin", redirect: "error" })
      .then((response) => (response.ok ? response.text() : undefined))
      .catch(() => undefined)
      .then((source) => {
        // A failed load tries again for the next preview.
        if (source === undefined) loads.delete(pluginId);
        return source;
      });
    loads.set(pluginId, load);
  }
  return load;
}
