import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { WhiteboardInfo } from "../lib/whiteboard-info.tsx";
import { WhiteboardMount } from "./mount.tsx";

/** The navPanel route's session id: the first path segment, if any. */
export function routeSessionId(subPath: string): string | undefined {
  const segment = subPath.split("/")[0] ?? "";
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    // A hand-typed URL with a stray "%": use the segment as written.
    return segment;
  }
}

/**
 * The `navPanel` route (design §3.6): Home at "", the full-page canvas at
 * "<sessionId>". Home has no thread, so it opens sessions here through
 * `toPluginPanel`, and browser back returns to the list. The way back from a
 * session is `HomeHeader`, in bb's title bar.
 */
export function HomePanel({ subPath }: PluginNavPanelProps) {
  const sessionId = routeSessionId(subPath);
  return (
    <div className="h-full min-h-0 w-full bg-background" data-wb-panel="nav">
      <WhiteboardInfo {...(sessionId ? { sessionId } : {})}>
        {(info) => (
          <WhiteboardMount
            key={sessionId ?? ""}
            info={info}
            {...(sessionId ? { sessionId } : {})}
          />
        )}
      </WhiteboardInfo>
    </div>
  );
}
