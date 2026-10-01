import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { WhiteboardInfo } from "../lib/whiteboard-info.tsx";
import { WhiteboardMount } from "./mount.tsx";

/** `params` is persisted JSON; only a string `sessionId` names a session. */
export function panelSessionId(params: PluginThreadPanelProps["params"]): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  const sessionId = params.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * The `threadPanelAction` panel (design §3.6). With `params.sessionId` it
 * mounts that session's canvas. Without one it shows Home, whose entries
 * open as this thread's Whiteboard tabs.
 */
export function SessionPanel({ threadId, params }: PluginThreadPanelProps) {
  const sessionId = panelSessionId(params);
  return (
    <div className="h-full min-h-0 w-full" data-wb-panel="thread">
      <WhiteboardInfo threadId={threadId} {...(sessionId ? { sessionId } : {})}>
        {(info) => (
          <WhiteboardMount
            key={sessionId ?? ""}
            threadId={threadId}
            info={info}
            {...(sessionId ? { sessionId } : {})}
          />
        )}
      </WhiteboardInfo>
    </div>
  );
}
