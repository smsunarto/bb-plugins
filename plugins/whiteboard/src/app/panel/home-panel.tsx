import { type PluginNavPanelProps, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { NAV_PANEL_PATH } from "../../shared/contracts/panel.ts";
import { Button } from "../components/ui/button.tsx";
import { WhiteboardInfo } from "../lib/whiteboard-info.tsx";
import { WhiteboardMount } from "./mount.tsx";

export const ALL_WHITEBOARDS = "All Whiteboards";

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
 * `toPluginPanel`, and browser back returns to the list.
 */
export function HomePanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const sessionId = routeSessionId(subPath);
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background" data-wb-panel="nav">
      {sessionId ? (
        <div className="flex shrink-0 items-center border-b border-border px-2 py-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate.toPluginPanel(NAV_PANEL_PATH, { subPath: "" })}
          >
            ← {ALL_WHITEBOARDS}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
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
    </div>
  );
}
