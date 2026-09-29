import { useLayoutEffect, useRef, type ReactElement } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ProviderGlyph, type ProviderGlyphInfo } from "./provider-glyph";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { cn } from "../../lib/utils";
import { MachineGlobe } from "./machine-globe";
import { useRemoteMachine } from "./machine-appearance";

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
 */
export function HostLead({ host }: { host: PluginSidebarThread["host"] }) {
  const remote = useRemoteMachine(host);
  if (!remote || !host) return null;
  return (
    <span className="gtd-host-lead" aria-label={`On ${host.name}`}>
      <MachineGlobe machine={host} />
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
  const portalScope = usePortalScopeProps();
  if (!enabled) return children;
  return (
    <Tooltip.Provider delayDuration={550}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            {...portalScope}
            side="right"
            sideOffset={8}
            className="gtd-thread-tooltip z-50 max-w-80 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
          >
            <div className="font-medium">{thread.displayTitle}</div>
            <div className="mt-1 text-muted-foreground">
              {[projectName, branchName].filter(Boolean).join(" · ")}
            </div>
            {relation ? <div className="mt-1 text-muted-foreground">{relation}</div> : null}
            <div className="mt-1.5 flex items-center gap-1.5 text-muted-foreground">
              <ProviderGlyph providerId={thread.providerId} provider={provider} />
              {provider?.displayName ?? thread.providerId}
            </div>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
