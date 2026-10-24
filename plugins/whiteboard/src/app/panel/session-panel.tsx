import type { ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { WhiteboardInfo } from "../lib/whiteboard-info.tsx";
import { WhiteboardMount } from "./mount.tsx";

/** `params` is persisted JSON; only a string `sessionId` names a session. */
export function panelSessionId(
  params: ExperimentalThreadActionTabProps["params"],
): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  const sessionId = params.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * The thread action tab (design §3.6). With `params.sessionId` it
 * mounts that session's canvas. Without one it shows Home, whose entries
 * open as this thread's Whiteboard tabs.
 */
export function SessionPanel({ threadId, params }: ExperimentalThreadActionTabProps) {
  const sessionId = panelSessionId(params);
  return (
    <div className="h-full min-h-0 w-full" data-wb-panel="thread">
      <WhiteboardInfo threadId={threadId} {...(sessionId ? { sessionId } : {})}>
        {(info) => (
          <WhiteboardMount
            key={`${threadId}:${info.sessionId ?? sessionId ?? ""}`}
            threadId={threadId}
            info={info}
            {...((info.sessionId ?? sessionId) ? { sessionId: info.sessionId ?? sessionId } : {})}
          />
        )}
      </WhiteboardInfo>
    </div>
  );
}
