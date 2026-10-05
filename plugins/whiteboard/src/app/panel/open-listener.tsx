import { useBbNavigate, useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import type { BbNavigate, PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { PendingOpen } from "../../shared/contracts/api-tunnel.ts";
import { CHANNELS, openPayload } from "../../shared/contracts/channels.ts";
import { PANEL_ACTION_ID } from "../../shared/contracts/panel.ts";
import { type WhiteboardRpcClient, rpc } from "../rpc.ts";

/**
 * Per thread, the newest open (`at`) this window focused. Module-level on
 * purpose, despite the SDK's per-thread-state advice: two panes showing the
 * same thread each mount a listener, and only one of them may focus (design
 * §3.6). It also orders answers: a claim that lands after a newer open
 * focused is older, so it focuses nothing.
 */
const focused = new Map<string, number>();

/** The first caller for an open wins; an older open loses. */
function takeFocus(threadId: string, at: number): boolean {
  if (at <= (focused.get(threadId) ?? Number.NEGATIVE_INFINITY)) return false;
  focused.set(threadId, at);
  return true;
}

/** Focus `open`'s tab in the pane, and tell the server, so no other pane or visit does. */
function focusOpen(
  client: WhiteboardRpcClient,
  navigate: BbNavigate,
  threadId: string,
  open: PendingOpen,
): void {
  client.claimOpen({ threadId, after: open.at }).catch(() => {});
  navigate.openThreadPanel({
    actionId: PANEL_ACTION_ID,
    title: open.title,
    params: { sessionId: open.sessionId },
  });
}

/**
 * The `experimental_threadHeaderAction` listener: focuses the tab the server
 * added for an agent's open, only in a pane that shows that thread, and never
 * on a compact viewport (where `openThreadPanel` opens a drawer over the chat).
 * A pane that shows the thread at the time hears `whiteboard:open`. A pane
 * that shows it later, or that was offline when it was sent, reads the open
 * from the server on mount and on reconnect, so returning to the thread
 * within 5 minutes still focuses the tab. The server keeps an open until a
 * client that focused it says so, so a pane that moved on, or a failed read,
 * loses nothing. It never navigates to another thread. Renders null, so it
 * adds no chrome.
 */
export function OpenListener({ threadId, isCompactViewport }: PluginThreadHeaderActionProps): null {
  const navigate = useBbNavigate();
  const client = rpc.useClient();
  const connected = useRealtimeConnectionState() === "connected";
  // What the pane shows, as committed, so a claim that lands after the pane
  // moved to another thread, turned compact or unmounted focuses nothing and
  // leaves the open on the server. Layout effects run inside the commit, so
  // no claim's answer lands between a render and this update.
  const shown = useRef<{ threadId: string; isCompactViewport: boolean } | undefined>(undefined);
  const latestNavigate = useRef(navigate);
  useLayoutEffect(() => {
    shown.current = { threadId, isCompactViewport };
    latestNavigate.current = navigate;
    return () => {
      shown.current = undefined;
    };
  });
  useEffect(() => {
    if (isCompactViewport || !connected) return;
    const focusWaiting = async () => {
      const { open } = await client.claimOpen({ threadId, after: focused.get(threadId) });
      const now = shown.current;
      if (!open || now?.threadId !== threadId || now.isCompactViewport) return;
      if (takeFocus(threadId, open.at)) focusOpen(client, latestNavigate.current, threadId, open);
    };
    // A failed claim leaves the tab where it is, as before this listener.
    focusWaiting().catch(() => {});
  }, [client, threadId, isCompactViewport, connected]);
  useRealtime(CHANNELS.open, (payload) => {
    const event = openPayload.safeParse(payload);
    if (!event.success || event.data.threadId !== threadId || isCompactViewport) return;
    if (takeFocus(threadId, event.data.at)) focusOpen(client, navigate, threadId, event.data);
  });
  return null;
}
