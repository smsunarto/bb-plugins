/**
 * A hidden per-pane marker carrying the pane's thread id.
 *
 * The thread-header slot is the one always-mounted React surface that names
 * its own thread, so it is where "Jump to latest event" learns which pane
 * shows a thread. It renders no control: `timeline-motion.css` hides the
 * host's group wrapper so the header row keeps its own spacing.
 */

import type { ReactNode } from "react";
import { PROBE_ATTRIBUTE } from "./thread-activity.ts";

export const PROBE_GROUP_TITLE = "Thread pane marker";

/** bb still mounts the legacy thread-header slot; SDK 0.6.92 dropped its types. */
export interface LegacyThreadHeaderActionSlots {
  experimental_threadHeaderAction(registration: {
    id: string;
    title: string;
    component: (props: { threadId: string }) => ReactNode;
  }): void;
}

export function ThreadActivityProbe({ threadId }: { threadId: string }) {
  return <span hidden {...{ [PROBE_ATTRIBUTE]: threadId }} />;
}
