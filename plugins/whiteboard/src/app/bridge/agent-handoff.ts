import type { ComposerInsertPart } from "@get-bb/plugin-sdk/app";
import {
  SESSION_MENTION_PROVIDER,
  type SelectionHandoff,
  selectionHandoff,
  sessionMentionId,
} from "../../shared/contracts/selection-handoff.ts";

/**
 * "Add to chat" for the review selection popover (agent-selection.tsx
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
 * The review app's `copyText(text)`, given the copy-context route's `handoff` and
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

/**
 * What "Add to chat" appends to a composer: the selection as a Markdown quote,
 * then, on the next line, a pill naming the session version it came from.
 */
export function handoffParts(handoff: SelectionHandoff): ComposerInsertPart[] {
  const pill = {
    provider: SESSION_MENTION_PROVIDER,
    id: sessionMentionId(handoff),
    label: handoff.title,
  };
  const text = handoff.quote.replace(/\r\n?/gu, "\n").trim();
  if (text.length === 0) return [pill, " "];
  const quote = text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return [`${quote}\n`, pill, " "];
}
