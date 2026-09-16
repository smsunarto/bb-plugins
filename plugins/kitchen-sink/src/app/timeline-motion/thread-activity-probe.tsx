/**
 * A hidden per-pane marker carrying the pane's thread id and whether that
 * thread is working, plus the bridge that hands the smooth-scroll setting to
 * the scroll router.
 *
 * The thread-header slot is the one always-mounted React surface that names
 * its own thread, so it is where the plugin learns facts the timeline's DOM
 * never states and a content script cannot ask the SDK for. It renders no
 * control: `timeline-motion.css` hides the host's group wrapper so the header
 * row keeps its own spacing.
 */

import { useLayoutEffect } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { SMOOTH_SCROLL_SETTING } from "../../shared/timeline-motion.ts";
import { isThreadWorking, PROBE_ATTRIBUTE, PROBE_WORKING_ATTRIBUTE } from "./thread-activity.ts";
import { setTimelineMotionEnabled } from "./timeline-motion.ts";

export const PROBE_GROUP_TITLE = "Thread scroll activity";

export function ThreadActivityProbe({ threadId }: PluginThreadHeaderActionProps) {
  const { threads } = useSidebarThreads();
  const thread = threads.find((candidate) => candidate.id === threadId);
  // Unknown (still loading) reads as the setting's default: on. Layout timing
  // lands the value before bb's own effects issue the pane's first restore.
  const smoothScroll = useSettings().values?.[SMOOTH_SCROLL_SETTING] !== false;
  useLayoutEffect(() => setTimelineMotionEnabled(smoothScroll), [smoothScroll]);
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
