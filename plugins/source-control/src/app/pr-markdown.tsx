/**
 * A pull request's Markdown, as bb renders a chat message, with each GitHub
 * image pointed at the plugin's `/pr-image` route: GitHub serves a private
 * repository's images only to someone signed in, which the page is not.
 */
import { Markdown, experimental_usePluginId as usePluginId } from "@get-bb/plugin-sdk/app";
import { createContext, useContext, useMemo } from "react";
import type { ChangeKey } from "../core/ids.ts";
import { PR_IMAGE_PATH, routeGitHubImages, servesImage } from "../core/pr-images.ts";
import { parseChangeKey } from "../core/review.ts";

/** The Change whose pull request the Markdown below comes from. */
export const PrImagesContext = createContext<ChangeKey | null>(null);

/** Where the page asks for `src`, an image in `key`'s pull request. */
export function prImageUrl(pluginId: string, key: ChangeKey, src: string, origin: string): string {
  const query = new URLSearchParams({ change: key, src }).toString();
  // Markdown ends a destination at ")": keep parentheses out of the URL.
  return `${origin}/api/v1/plugins/${encodeURIComponent(pluginId)}/http${PR_IMAGE_PATH}?${query}`
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
}

export function PrMarkdown({
  content,
  className,
  changeKey,
}: {
  content: string;
  className?: string;
  /** Defaults to the surrounding `PrImagesContext`. */
  changeKey?: ChangeKey;
}) {
  const pluginId = usePluginId();
  const around = useContext(PrImagesContext);
  const given = changeKey ?? around;
  // Only a GitHub Change has a pull request whose images the route can resolve.
  const parsed = given === null ? null : parseChangeKey(given);
  const key = parsed?.kind === "gh" ? given : null;
  const routed = useMemo(() => {
    const change = key === null ? null : parseChangeKey(key);
    if (key === null || change?.kind !== "gh") return content;
    return routeGitHubImages(
      content,
      // bb builds its own API URLs from the page's origin too.
      (src) => prImageUrl(pluginId, key, src, window.location.origin),
      (image) => servesImage(image, change.repo, change.headOwner),
    );
  }, [content, key, pluginId]);
  return <Markdown content={routed} className={className} />;
}
