import { useLayoutEffect, useRef } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { experimental_Icon as RegistryIcon } from "@get-bb/plugin-sdk/app";
import { CAPTAIN_DEFAULT_GLYPH, CAPTAIN_PLUGIN_ID, useCaptainIcon } from "../../lib/captain-icons";
import { MachineGlobe } from "./machine-globe";
import { useMachineColors, useRemoteMachine } from "./machine-appearance";

// One observer for every label. It runs after layout, reads each label once,
// then writes only the flags that changed, so a list mounting a thousand rows
// never forces a layout per row.
let overflowObserver: ResizeObserver | null = null;
function observeOverflow(element: HTMLElement) {
  overflowObserver ??= new ResizeObserver((entries) => {
    const measured = entries.map(({ target }) => ({
      target: target as HTMLElement,
      overflowing: String(target.scrollWidth > target.clientWidth + 1),
    }));
    for (const { target, overflowing } of measured) {
      if (target.dataset.overflowing !== overflowing) target.dataset.overflowing = overflowing;
    }
  });
  overflowObserver.observe(element);
  return () => overflowObserver?.unobserve(element);
}

/**
 * A title the auto-namer is still writing wears bb's working sweep, an
 * animated mask the compositor advances. The `background-position` keyframe it
 * replaces repainted on the main thread every frame and froze whenever that
 * thread was busy. bb drops the sweep under reduced motion, so the title dims
 * there instead, as bb's own pending rename does.
 */
export const NAMING_TITLE_CLASS = "animate-shine motion-reduce:opacity-60";

export function FadingText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  // Re-observing on a text change queues a fresh measurement: a longer title
  // can overflow without changing the label's box.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeOverflow(element);
  }, [text]);
  return (
    <span ref={ref} className={cn("gtd-fading-text", className)}>
      {text}
    </span>
  );
}

/**
 * The row's leading globe, drawn only when the thread runs on another
 * machine. A local title starts straight after the disclosure column; a
 * remote title sits one globe further right. The project itself lives in the
 * group header above the row, never on the title line.
 *
 * A live Captain leads with its own icon instead, local or remote, read from
 * the Captain plugin. While that read loads the row holds an empty lead; when
 * Captain is disabled, the read fails, or the thread is not a live Captain
 * (such as an archived one), the row keeps its globe.
 */
export function HostLead({
  thread,
}: {
  thread: Pick<PluginSidebarThread, "id" | "host" | "originPluginId">;
}) {
  if (thread.originPluginId === CAPTAIN_PLUGIN_ID) return <CaptainLead thread={thread} />;
  return <GlobeLead host={thread.host} />;
}

function GlobeLead({ host }: { host: PluginSidebarThread["host"] }) {
  const remote = useRemoteMachine(host);
  if (!remote || !host) return null;
  return (
    <span className="gtd-host-lead" aria-label={`On ${host.name}`}>
      <MachineGlobe machine={host} />
    </span>
  );
}

function CaptainLead({ thread }: { thread: Pick<PluginSidebarThread, "id" | "host"> }) {
  const lead = useCaptainIcon(thread.id);
  const remote = useRemoteMachine(thread.host);
  const colorOf = useMachineColors();
  // Hold the lead's box while the read loads, so the title doesn't move when it lands.
  if (lead.state === "loading")
    return <span className="gtd-host-lead" aria-hidden="true" data-captain-icon="loading" />;
  if (lead.state === "none") return <GlobeLead host={thread.host} />;
  const { icon } = lead;
  const host = remote ? thread.host : null;
  return (
    <span
      className="gtd-host-lead"
      aria-label={host ? `Captain, on ${host.name}` : "Captain"}
      data-captain-icon={icon.kind}
      // A remote Captain's glyph keeps its machine's color, as the globe did.
      style={host && icon.kind !== "image" ? { color: colorOf(host.id) } : undefined}
    >
      {icon.kind === "image" ? (
        <img src={icon.src} alt="" aria-hidden="true" className="size-3 rounded-xs object-cover" />
      ) : (
        <RegistryIcon
          name={icon.kind === "icon" ? icon.name : CAPTAIN_DEFAULT_GLYPH}
          fallback={CAPTAIN_DEFAULT_GLYPH}
          className="size-3"
          aria-hidden
        />
      )}
    </span>
  );
}
