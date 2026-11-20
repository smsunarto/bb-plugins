import { useLayoutEffect, useRef, type ReactElement } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ProviderGlyph, type ProviderGlyphInfo } from "./provider-glyph";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
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
 * the Captain plugin. Until that read lands, or when Captain is disabled or the
 * read fails, the row keeps its globe.
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
  const icon = useCaptainIcon(thread.id);
  const remote = useRemoteMachine(thread.host);
  const colorOf = useMachineColors();
  if (icon === null) return <GlobeLead host={thread.host} />;
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

export function ThreadDetails({
  thread,
  projectName,
  branchName,
  provider,
  relation,
  enabled,
  children,
}: {
  thread: PluginSidebarThread;
  projectName: string | null;
  branchName: string | null;
  provider?: ProviderGlyphInfo;
  relation?: string;
  enabled: boolean;
  children: ReactElement;
}) {
  // Rows show a remote machine only as a globe, so the details name it.
  const remote = useRemoteMachine(thread.host);
  if (!enabled) return children;
  return (
    <TooltipProvider delayDuration={550}>
      <Tooltip>
        {/* asChild keeps the anchor a direct child of the row, which the
            row's focus-visible selectors in app.css depend on. The kit's
            trigger opens on focus only after a key press, so a menu handing
            focus back after a mouse pick does not pin the details open. */}
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        {/* The details read as a card, not a label: the popover ground. */}
        <TooltipContent
          side="right"
          sideOffset={8}
          className="gtd-thread-tooltip max-w-80 border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md"
        >
          <div className="font-medium">{thread.displayTitle}</div>
          <div className="mt-1 text-muted-foreground">
            {[projectName, branchName, remote ? thread.host?.name : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {relation ? <div className="mt-1 text-muted-foreground">{relation}</div> : null}
          <div className="mt-2 flex items-center gap-1 text-muted-foreground">
            <ProviderGlyph providerId={thread.providerId} provider={provider} />
            {provider?.displayName ?? thread.providerId}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
