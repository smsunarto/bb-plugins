import {
  type SelectionHandoff,
  selectionHandoff,
} from "../../shared/contracts/selection-handoff.ts";

/**
 * "Add to chat" for the vendored selection popover (agent-selection.tsx
 * imports this module in place of copy-text.tsx). Upstream copies the
 * selection's context for an agent in another app. In bb the agent sits
 * beside the canvas, so each mount registers a sink that hands the route's
 * handoff to its composer. Sinks are keyed by the mount's root, so two open
 * panes each reach their own composer.
 */
export type HandoffSink = (handoff: SelectionHandoff) => void;

const sinks = new WeakMap<Element, HandoffSink>();

/** Returns the unregister function. */
export function registerHandoffSink(root: Element, sink: HandoffSink): () => void {
  sinks.set(root, sink);
  return () => {
    if (sinks.get(root) === sink) sinks.delete(root);
  };
}

/**
 * The vendored `copyText(text)`, given the copy-context route's `handoff` and
 * the element the selection was made in. The popover captures `origin` when
 * the user selects, so a reply that lands after focus moved to another pane
 * still reaches the pane that asked. Every mount registers a sink, so a miss
 * means a broken handoff: it returns false and the popover reports the
 * failure. Upstream's agent `text` has no use here.
 */
export async function copyText(
  _text: string,
  handoff: unknown,
  origin: Element | undefined,
): Promise<boolean> {
  const root = origin?.closest(".review-canvas-root");
  const sink = root ? sinks.get(root) : undefined;
  const parsed = selectionHandoff.safeParse(handoff);
  if (!sink || !parsed.success) return false;
  sink(parsed.data);
  return true;
}
