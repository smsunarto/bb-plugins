import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { CHANNELS, openPayload } from "../../shared/contracts/channels.ts";
import { PANEL_ACTION_ID } from "../../shared/contracts/panel.ts";

/** How long a handled `whiteboard:open` nonce is remembered. */
export const NONCE_TTL_MS = 60_000;

/**
 * Nonces already focused in this window. Module-level on purpose, despite the
 * SDK's per-thread-state advice: two panes showing the same thread each mount
 * a listener, and only one of them may focus (design §3.6).
 */
const handled = new Map<string, number>();

/** First caller for a nonce wins; expired entries are dropped on the way. */
function claim(nonce: string, now: number): boolean {
  for (const [seen, at] of handled) if (now - at >= NONCE_TTL_MS) handled.delete(seen);
  if (handled.has(nonce)) return false;
  handled.set(nonce, now);
  return true;
}

/**
 * The `experimental_threadHeaderAction` listener: focuses the tab the server
 * added on `whiteboard:open`, only in a pane that shows that thread, and never
 * on a compact viewport (where `openThreadPanel` opens a drawer over the chat).
 * It never navigates to another thread. Renders null, so it adds no chrome.
 */
export function OpenListener({ threadId, isCompactViewport }: PluginThreadHeaderActionProps): null {
  const navigate = useBbNavigate();
  useRealtime(CHANNELS.open, (payload) => {
    const event = openPayload.safeParse(payload);
    if (!event.success || event.data.threadId !== threadId || isCompactViewport) return;
    if (!claim(event.data.nonce, Date.now())) return;
    navigate.openThreadPanel({
      actionId: PANEL_ACTION_ID,
      title: event.data.title,
      params: { sessionId: event.data.sessionId },
    });
  });
  return null;
}
