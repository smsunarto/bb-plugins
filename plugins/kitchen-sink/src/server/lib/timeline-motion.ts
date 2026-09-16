import type { BbPluginApi, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { SMOOTH_SCROLL_SETTING } from "../../shared/timeline-motion.ts";

/**
 * Declares the smooth-scroll switch so bb renders it under Tools → Kitchen Sink
 * and pushes its value to the app bundle's `useSettings()`. The router reads it
 * there; nothing server-side depends on it.
 */
export function registerTimelineMotionSettings(bb: BbPluginApi): void {
  bb.settings.define({
    [SMOOTH_SCROLL_SETTING]: {
      type: "boolean",
      label: "Smooth thread scrolling",
      description:
        "Animate automatic timeline scrolling: new rows, restored positions, and scroll to latest. Off keeps bb's instant scrolling.",
      default: true,
    },
  } satisfies Record<string, PluginSettingDescriptor>);
}
