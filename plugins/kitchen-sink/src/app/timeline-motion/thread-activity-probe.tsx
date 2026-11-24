import { PROBE_ATTRIBUTE } from "./thread-activity.ts";

/** Lets "Jump to latest event" identify each pane by its own thread id. */
export function ThreadActivityProbe({ threadId }: { threadId: string }) {
  return <span hidden {...{ [PROBE_ATTRIBUTE]: threadId }} />;
}
