// On a phone, the machine and environment row above the new-thread card opens this sheet in
// place of BB's picker, as the model row opens the model sheet. Picks go through
// `setSelection`, the path BB's picker takes; what the SDK cannot set (reusing an environment,
// setting up a machine, a machine an environment creates) stays in BB's picker, one tap away.
import { memo, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { experimental_ProviderIcon as ProviderIcon, useSdk } from "@get-bb/plugin-sdk/app";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { usePickerComposer } from "../composer-handle";
import { applySelection } from "../composer-settings/apply-selection";
import { hasEditablePickers } from "../model-picker/ComposerModelControls";
import { retryMachineData, useMachineData, type MachineData } from "./machine-data";
import {
  environmentChoices,
  environmentForHost,
  pickableHosts,
  placementOf,
  placementSelection,
  type EnvironmentChoice,
  type Host,
} from "./machine-options";

/** BB's machine or environment button in the new-thread row; see app.css for the row. */
const BB_TRIGGER =
  '[data-new-thread-footer] button:is([aria-label="Environment"], [aria-label="Machine"])';

/**
 * Opens the machine sheet when BB's machine button is pressed on a phone. `anchor` is any node
 * inside this composer; the press is caught on BB's wrapper around it, before BB's button
 * sees it, so only this composer's row is taken over.
 */
export const NewThreadMachineSheet = memo(function NewThreadMachineSheet(props: {
  anchor: RefObject<HTMLElement | null>;
}) {
  const composer = usePickerComposer();
  const isSheet = useIsCompactViewport();
  const enabled = isSheet && hasEditablePickers(composer) && composer.selection?.projectId != null;
  const [open, setOpen] = useState(false);
  const passThrough = useRef(false);

  useEffect(() => {
    const host = props.anchor.current?.closest("[data-app-composer]");
    if (!enabled || !host) return;
    const onClick = (event: Event) => {
      const trigger = (event.target as Element | null)?.closest?.(BB_TRIGGER);
      if (!trigger || !host.contains(trigger) || (trigger as HTMLButtonElement).disabled) return;
      if (passThrough.current) {
        passThrough.current = false;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
    };
    host.addEventListener("click", onClick, true);
    return () => host.removeEventListener("click", onClick, true);
  }, [enabled, props.anchor]);

  // Leaving the phone layout with the sheet open hands the row back to BB.
  if (!enabled && open) setOpen(false);

  const openBbPicker = () => {
    setOpen(false);
    const trigger = props.anchor.current
      ?.closest("[data-app-composer]")
      ?.querySelector<HTMLButtonElement>(BB_TRIGGER);
    if (!trigger) return;
    // After this sheet starts closing, so the two never hold focus at once.
    requestAnimationFrame(() => {
      passThrough.current = true;
      trigger.click();
      passThrough.current = false;
    });
  };

  return <MachineSheet open={open} onOpenChange={setOpen} onMoreOptions={openBbPicker} />;
});

function MachineSheet(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onMoreOptions(): void;
}) {
  const titleId = useId();
  return (
    <ResponsiveDrawerShell open={props.open} onOpenChange={props.onOpenChange} labelledBy={titleId}>
      <MachineSheetContent
        open={props.open}
        titleId={titleId}
        onDone={() => props.onOpenChange(false)}
        onMoreOptions={props.onMoreOptions}
      />
    </ResponsiveDrawerShell>
  );
}

/** What the sheet lists, from what has loaded so far. */
function sheetView(data: MachineData, viewedHostId: string | null) {
  const hosts = pickableHosts(data.hosts.value ?? []);
  const { value: providers } = data.providers;
  const { value: project } = data.project;
  return {
    hosts,
    // An environment that brings its own machine names none; with one machine, list its own.
    viewedHost:
      hosts.find((host) => host.id === viewedHostId) ?? (hosts.length === 1 ? hosts[0]! : null),
    /** Null until the project and its environment catalog have loaded. */
    choicesFor: (hostId: string) =>
      providers && project ? environmentChoices(providers, project, hostId) : null,
    listsMachines: hosts.length > 1 || (!data.hosts.value && data.hosts.loading),
    refreshing:
      data.hosts.value !== undefined &&
      (data.hosts.loading || data.providers.loading || data.project.loading),
  };
}

function MachineSheetContent(props: {
  open: boolean;
  titleId: string;
  onDone(): void;
  onMoreOptions(): void;
}) {
  const composer = usePickerComposer();
  const projectId = composer.selection?.projectId;
  const data = useMachineData(projectId, props.open);
  const placement = placementOf(composer.selection?.environment);
  const picker = usePlacementPicker();
  // The machine whose environments are listed: the chosen one until another is tapped.
  const [viewedHostId, setViewedHostId] = useState(placement.hostId);
  // Each opening starts on the chosen machine, with no stale error.
  const [openedFor, setOpenedFor] = useState(props.open);
  if (openedFor !== props.open) {
    setOpenedFor(props.open);
    if (props.open) {
      setViewedHostId(placement.hostId);
      picker.clearError();
    }
  }

  const { hosts, viewedHost, choicesFor, listsMachines, refreshing } = sheetView(
    data,
    viewedHostId,
  );

  const pickHost = (host: Host) => {
    setViewedHostId(host.id);
    const provider = environmentForHost(choicesFor(host.id) ?? [], placement.providerId);
    if (!provider || (host.id === placement.hostId && provider.id === placement.providerId)) {
      return;
    }
    picker.apply(`host:${host.id}`, host.id, provider.id);
  };

  return (
    <div data-t3-machine-sheet="" className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-baseline justify-between gap-3 px-5 pb-2">
        <h2 id={props.titleId} className="text-base font-semibold">
          Run on
        </h2>
        {refreshing ? <span className="text-xs text-muted-foreground">Refreshing…</span> : null}
      </div>
      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-2 pb-3">
        <LoadFailure data={data} projectId={projectId} />
        {listsMachines ? (
          <MachineSection
            hosts={data.hosts.value ? hosts : null}
            viewedHostId={viewedHost?.id ?? null}
            chosenHostId={placement.hostId}
            pending={picker.pending}
            onPick={pickHost}
          />
        ) : null}
        {viewedHost || !data.hosts.value ? (
          <EnvironmentSection
            host={viewedHost}
            named={hosts.length > 1}
            choices={viewedHost ? choicesFor(viewedHost.id) : null}
            chosenProviderId={viewedHost?.id === placement.hostId ? placement.providerId : null}
            pending={picker.pending}
            onPick={(host, providerId) =>
              picker.apply(`env:${providerId}`, host.id, providerId, props.onDone)
            }
          />
        ) : null}
        {picker.error ? (
          <p role="alert" className="px-3 text-sm text-destructive">
            {picker.error}
          </p>
        ) : null}
        <Separator className="my-1" />
        <SheetRow
          icon={<Icon name="MoreHorizontal" aria-hidden className="size-5" />}
          title="More options"
          detail="Reuse an environment or set up a machine"
          trailing={
            <Icon name="ChevronRight" aria-hidden className="size-4 text-muted-foreground" />
          }
          onPick={props.onMoreOptions}
        />
      </div>
    </div>
  );
}

/**
 * Applies a machine and environment through BB, one pick at a time: a later pick supersedes
 * an earlier one still in flight. `pending` names the row waiting on BB.
 */
function usePlacementPicker() {
  const composer = usePickerComposer();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestPick = useRef(0);

  const apply = (key: string, hostId: string, providerId: string, onApplied?: () => void) => {
    const pick = ++latestPick.current;
    setPending(key);
    setError(null);
    void applySelection(composer, placementSelection(hostId, providerId)).then(
      ({ applied, error }) => {
        if (pick !== latestPick.current) return null;
        const landed = placementOf(applied?.environment);
        const refused =
          error ??
          (applied && (landed.hostId !== hostId || landed.providerId !== providerId)
            ? "BB kept the current environment."
            : null);
        setPending(null);
        setError(refused);
        if (!refused) onApplied?.();
        return null;
      },
    );
  };

  return { pending, error, apply, clearError: () => setError(null) };
}

function LoadFailure(props: { data: MachineData; projectId: string | undefined }) {
  const sdk = useSdk();
  const { data, projectId } = props;
  const failure = data.hosts.error ?? data.providers.error ?? data.project.error;
  if (!failure) return null;
  return (
    <div
      role="alert"
      className="mx-3 mb-1 flex items-center justify-between gap-3 text-sm text-muted-foreground"
    >
      <span className="min-w-0">{failure}</span>
      {projectId ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => retryMachineData(sdk, projectId)}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function MachineSection(props: {
  /** Null while the machines load. */
  hosts: Host[] | null;
  viewedHostId: string | null;
  chosenHostId: string | null;
  pending: string | null;
  onPick(host: Host): void;
}) {
  return (
    <>
      <Section title="Machines">
        {props.hosts ? (
          props.hosts.map((host) => (
            <MachineRow
              key={host.id}
              host={host}
              viewed={host.id === props.viewedHostId}
              chosen={host.id === props.chosenHostId}
              pending={props.pending === `host:${host.id}`}
              onPick={() => props.onPick(host)}
            />
          ))
        ) : (
          <RowPlaceholders count={3} />
        )}
      </Section>
      <Separator className="my-1" />
    </>
  );
}

function EnvironmentSection(props: {
  /** Null while the machines load. */
  host: Host | null;
  /** Whether the sheet lists several machines, so this list names the one it is for. */
  named: boolean;
  /** Null while the project's environments load. */
  choices: EnvironmentChoice[] | null;
  chosenProviderId: string | null;
  pending: string | null;
  onPick(host: Host, providerId: string): void;
}) {
  const { host, choices } = props;
  const offline = host?.status !== "connected";
  let body: ReactNode;
  if (!host || !choices) body = <RowPlaceholders count={2} />;
  else if (choices.length === 0) {
    body = (
      <EmptyState
        message={
          offline ? "This machine is offline." : "This project has no environment on this machine."
        }
        className="mx-3 my-2"
        messageClassName="text-sm"
      />
    );
  } else {
    body = choices.map((choice) => (
      <EnvironmentRow
        key={choice.provider.id}
        choice={choice}
        chosen={choice.provider.id === props.chosenProviderId}
        offline={offline}
        pending={props.pending === `env:${choice.provider.id}`}
        onPick={() => props.onPick(host, choice.provider.id)}
      />
    ));
  }
  return <Section title={host && props.named ? `On ${host.name}` : "Environment"}>{body}</Section>;
}

function Section(props: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col">
      <h3 id={id} className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
        {props.title}
      </h3>
      <ul className="flex flex-col gap-1">{props.children}</ul>
    </section>
  );
}

function MachineRow(props: {
  host: Host;
  viewed: boolean;
  chosen: boolean;
  pending: boolean;
  onPick(): void;
}) {
  const { host } = props;
  const connected = host.status === "connected";
  return (
    <li>
      <SheetRow
        icon={<Icon name="Laptop" aria-hidden className="size-5" />}
        title={host.name}
        detail={
          <span className="flex min-w-0 items-center gap-1">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                connected ? "bg-success" : "border border-muted-foreground",
              )}
            />
            <span className="truncate">{connected ? "Online" : lastSeen(host.lastSeenAt)}</span>
          </span>
        }
        selected={props.viewed}
        checked={props.chosen}
        pending={props.pending}
        disabled={!connected}
        onPick={props.onPick}
      />
    </li>
  );
}

function EnvironmentRow(props: {
  choice: EnvironmentChoice;
  chosen: boolean;
  offline: boolean;
  pending: boolean;
  onPick(): void;
}) {
  const { provider, disabledReason, note } = props.choice;
  return (
    <li>
      <SheetRow
        icon={
          <ProviderIcon
            providerKind="environment"
            provider={provider}
            fallback="Folder"
            className="size-5"
            aria-hidden
          />
        }
        title={provider.displayName}
        detail={disabledReason ?? provider.description}
        badge={note ? <Badge variant="warning">Setup needed</Badge> : null}
        selected={props.chosen}
        checked={props.chosen}
        pending={props.pending}
        disabled={props.offline || disabledReason !== null}
        onPick={props.onPick}
      />
    </li>
  );
}

/** One touch-sized row: icon, name, a muted line under it, and a fixed check column. */
function SheetRow(props: {
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  badge?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  checked?: boolean;
  pending?: boolean;
  disabled?: boolean;
  onPick(): void;
}) {
  return (
    <button
      type="button"
      aria-current={props.checked ? "true" : undefined}
      aria-busy={props.pending || undefined}
      disabled={props.disabled}
      onClick={props.onPick}
      className={cn(
        "flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring active:bg-foreground/[0.09]",
        props.selected && "bg-foreground/[0.06]",
        props.disabled && "opacity-50",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-base text-foreground">{props.title}</span>
          {props.badge}
        </span>
        {props.detail ? (
          <span className="truncate text-sm text-muted-foreground">{props.detail}</span>
        ) : null}
      </span>
      <span className="flex size-5 shrink-0 items-center justify-center">
        {props.pending ? (
          <Icon name="Spinner" aria-hidden className="size-4 animate-spin" />
        ) : (
          (props.trailing ?? (
            <Icon
              name="Check"
              aria-hidden
              className={cn("size-5", !props.checked && "invisible")}
            />
          ))
        )}
      </span>
    </button>
  );
}

function RowPlaceholders(props: { count: number }) {
  return Array.from({ length: props.count }, (_, index) => (
    <li key={index} aria-hidden className="flex min-h-14 items-center gap-3 px-3 py-2">
      <Skeleton className="size-8 shrink-0" />
      <span className="flex flex-1 flex-col gap-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-20" />
      </span>
    </li>
  ));
}

function lastSeen(at: number | null) {
  if (at === null) return "Offline";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 60) return `Last seen ${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Last seen ${hours}h ago`;
  return `Last seen ${Math.round(hours / 24)}d ago`;
}
