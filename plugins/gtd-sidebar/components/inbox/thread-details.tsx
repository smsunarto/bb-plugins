import { useLayoutEffect, useRef, type ReactElement } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ProviderGlyph, type ProviderGlyphInfo } from "./provider-glyph";
import { threadDisplayTitle } from "@/lib/inbox";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import { MachineGlobe } from "./machine-globe";
import { useRemoteMachine } from "./machine-appearance";

export function FadingText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      element.dataset.overflowing = String(element.scrollWidth > element.clientWidth + 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  return (
    <span ref={ref} className={cn("gtd-fading-text", className)}>
      {text}
    </span>
  );
}

export function ProjectChip({
  name,
  host,
}: {
  name: string | null;
  host: PluginSidebarThread["host"];
}) {
  const remote = useRemoteMachine(host);
  return name ? (
    <span className="gtd-project-chip" aria-label={host ? `${name} on ${host.name}` : name}>
      {remote ? <MachineGlobe machine={host} /> : null}
      <FadingText text={name} />
    </span>
  ) : null;
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
            <div className="font-medium">{threadDisplayTitle(thread)}</div>
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
