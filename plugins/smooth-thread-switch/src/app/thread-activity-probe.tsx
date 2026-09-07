/**
 * A hidden per-pane marker carrying the pane's thread id and whether that
 * thread is working.
 *
 * The thread-header slot is the one always-mounted React surface that names
 * its own thread, so it is where the plugin learns a fact the timeline's DOM
 * never states. It renders no control: `app.css` hides the host's group
 * wrapper so the header row keeps its own spacing.
 */

import {
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { isThreadWorking, PROBE_ATTRIBUTE, PROBE_WORKING_ATTRIBUTE } from "./thread-activity.ts";

export const PROBE_GROUP_TITLE = "Thread scroll activity";

export function ThreadActivityProbe({ threadId }: PluginThreadHeaderActionProps) {
  const { threads } = useSidebarThreads();
  const thread = threads.find((candidate) => candidate.id === threadId);
  return (
    <span
      hidden
      {...{
        [PROBE_ATTRIBUTE]: threadId,
        [PROBE_WORKING_ATTRIBUTE]:
          thread !== undefined && isThreadWorking(thread) ? "true" : "false",
      }}
    />
  );
}
