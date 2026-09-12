import { useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type {
  Initiative,
  InitiativeEnvironment,
  InitiativeSubscription,
  InitiativeSubscriptionConfig,
  InitiativeSubscriptionKind,
  SubscriptionScheduleConfig,
} from "@/lib/initiative-types";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import { localDatetimeInputValue, subscriptionLabel } from "@/lib/initiative-ui";
import { useInitiativeSubscriptions } from "@/hooks/use-initiative-subscriptions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { relativeTimeLabel } from "@/lib/relative-time";

const KIND_META: Record<InitiativeSubscriptionKind, { icon: IconName; label: string }> = {
  schedule: { icon: "Repeat", label: "Schedule" },
  "github-ci": { icon: "GitPullRequest", label: "GitHub CI" },
  "github-pr": { icon: "GitPullRequest", label: "GitHub PR" },
  "slack-channel": { icon: "Rss", label: "Slack channel" },
};

const STATUS_TONE: Record<string, string> = {
  ok: "text-primary",
  quiet: "text-muted-foreground",
  error: "text-destructive-text",
  rate_limited: "text-muted-foreground",
  delivery_error: "text-destructive-text",
};

/**
 * The subscriptions list, shared by the Listening tray (compact) and the
 * panel's Subscriptions tab. Rows come straight from the engine's store
 * records — label, derived schedule/source line, last result, last error.
 */
export function SubscriptionList({
  initiative,
  compact = false,
}: {
  initiative: Initiative;
  compact?: boolean;
}) {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const { status, subscriptions, retry } = useInitiativeSubscriptions(initiative.id);
  const [editing, setEditing] = useState<InitiativeSubscription | "new" | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  if (editing !== null) {
    return (
      <SubscriptionEditor
        initiative={initiative}
        existing={editing === "new" ? null : editing}
        onDone={() => setEditing(null)}
      />
    );
  }

  const toggle = (subscription: InitiativeSubscription) => {
    setRowError(null);
    rpc
      .call("upsertSubscription", {
        subscriptionId: subscription.id,
        initiativeId: subscription.initiativeId,
        kind: subscription.kind,
        label: subscription.label,
        prompt: subscription.prompt,
        // A corrupt row (config null) submits {}; the server rejects it with a
        // readable per-kind error that surfaces in rowError.
        config: subscription.config ?? {},
        enabled: !subscription.enabled,
        ...(subscription.pollIntervalMs !== null
          ? { pollIntervalMs: subscription.pollIntervalMs }
          : {}),
      })
      .catch((error: unknown) =>
        setRowError(error instanceof Error ? error.message : "Update failed"),
      );
  };

  return (
    <div className="flex flex-col" data-subscription-list="">
      {status === "loading" ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">Loading…</p>
      ) : status === "error" && subscriptions.length === 0 ? (
        <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">Couldn’t load subscriptions</span>
          <Button variant="ghost" size="xs" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : subscriptions.length === 0 ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          Nothing listening yet. Schedules and watched sources appear here.
        </p>
      ) : (
        <ul className={cn("flex flex-col gap-px", !compact && "max-h-72 overflow-y-auto")}>
          {subscriptions.map((subscription) => (
            <li
              key={subscription.id}
              className="flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/40"
              data-subscription-row={subscription.id}
            >
              <Icon
                name={KIND_META[subscription.kind].icon}
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{subscription.label}</div>
                <div className="truncate text-2xs text-muted-foreground">
                  {subscriptionLabel(subscription)}
                </div>
                {subscription.lastStatus !== null ? (
                  <div
                    className={cn(
                      "truncate text-2xs",
                      STATUS_TONE[subscription.lastStatus] ?? "text-muted-foreground",
                    )}
                  >
                    {subscription.lastStatus.replaceAll("_", " ")}
                    {subscription.lastRunAt !== null
                      ? ` · ${relativeTimeLabel(subscription.lastRunAt, Date.now())}`
                      : ""}
                  </div>
                ) : null}
                {subscription.configError !== null || subscription.lastError !== null ? (
                  <div className="truncate text-2xs text-destructive-text" role="alert">
                    {subscription.configError ?? subscription.lastError}
                  </div>
                ) : null}
                {subscription.kind === "slack-channel" &&
                subscription.lastError !== null &&
                /token|auth|config/i.test(subscription.lastError) ? (
                  <div className="text-2xs text-muted-foreground">
                    Set the Slack token in plugin settings.
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={subscription.enabled}
                  aria-label={`${subscription.enabled ? "Disable" : "Enable"} ${subscription.label}`}
                  onClick={() => toggle(subscription)}
                  className={cn(
                    "flex h-4 w-7 items-center rounded-full px-0.5 transition-colors",
                    subscription.enabled ? "bg-primary" : "bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "size-3 rounded-full bg-background transition-transform",
                      subscription.enabled && "translate-x-3",
                    )}
                  />
                </button>
                <button
                  type="button"
                  aria-label={`Run ${subscription.label} now`}
                  title="Run now"
                  onClick={() => {
                    setRowError(null);
                    rpc
                      .call("runSubscriptionNow", { subscriptionId: subscription.id })
                      .catch((error: unknown) =>
                        setRowError(error instanceof Error ? error.message : "Run failed"),
                      );
                  }}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Icon name="Play" className="size-3" aria-hidden />
                </button>
                {!compact ? (
                  <>
                    <button
                      type="button"
                      aria-label={`Edit ${subscription.label}`}
                      title="Edit"
                      onClick={() => setEditing(subscription)}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Icon name="Edit" className="size-3" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${subscription.label}`}
                      title="Delete"
                      onClick={() => {
                        setRowError(null);
                        rpc
                          .call("deleteSubscription", { subscriptionId: subscription.id })
                          .catch((error: unknown) =>
                            setRowError(error instanceof Error ? error.message : "Delete failed"),
                          );
                      }}
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive-text"
                    >
                      <Icon name="Delete" className="size-3" aria-hidden />
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {rowError !== null ? (
        <p role="alert" className="px-2 pt-1 text-2xs text-destructive">
          {rowError}
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => setEditing("new")}
        className="mt-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon name="Plus" className="size-3.5" aria-hidden />
        New subscription
      </button>
    </div>
  );
}

const CRON_PRESETS: readonly { id: string; label: string; expression?: string }[] = [
  { id: "hourly", label: "Every hour", expression: "0 * * * *" },
  { id: "daily", label: "Daily at 09:00", expression: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays at 09:00", expression: "0 9 * * 1-5" },
  { id: "custom", label: "Custom cron" },
  { id: "once", label: "Once at…" },
];

/**
 * Create/edit one subscription. Per-kind config fields map 1:1 onto the
 * engine's zod schemas, so an invalid row can't leave the form.
 */
function SubscriptionEditor({
  initiative,
  existing,
  onDone,
}: {
  initiative: Initiative;
  existing: InitiativeSubscription | null;
  onDone: () => void;
}) {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const { projects } = useSidebarThreads();
  const [kind, setKind] = useState<InitiativeSubscriptionKind>(existing?.kind ?? "schedule");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");

  const existingSchedule =
    existing?.kind === "schedule" && existing.config !== null
      ? (existing.config as SubscriptionScheduleConfig)
      : null;
  const [preset, setPreset] = useState<string>(() => {
    if (existingSchedule === null) return "daily";
    if (existingSchedule.schedule === "once") return "once";
    return CRON_PRESETS.some((p) => p.expression === existingSchedule.expression)
      ? CRON_PRESETS.find((p) => p.expression === existingSchedule.expression)!.id
      : "custom";
  });
  const [customCron, setCustomCron] = useState(
    existingSchedule?.schedule === "cron" ? existingSchedule.expression : "",
  );
  const [onceAt, setOnceAt] = useState(() => {
    if (existingSchedule?.schedule === "once") {
      return localDatetimeInputValue(existingSchedule.runAt);
    }
    return "";
  });

  const existingConfig = existing?.config as Record<string, unknown> | null;
  const [repo, setRepo] = useState(String(existingConfig?.repo ?? ""));
  const [branch, setBranch] = useState(String(existingConfig?.branch ?? ""));
  const [pr, setPr] = useState(String(existingConfig?.pr ?? ""));
  const [channelId, setChannelId] = useState(String(existingConfig?.channelId ?? ""));
  const [environmentId, setEnvironmentId] = useState<string>(
    String(existingConfig?.environmentId ?? ""),
  );
  const [environments, setEnvironments] = useState<readonly InitiativeEnvironment[]>([]);

  const envProjectId =
    initiative.workspaceProjectIds[0] ?? projects.find((project) => project.isPersonal)?.id ?? null;
  useEffect(() => {
    if (envProjectId === null || (kind !== "github-ci" && kind !== "github-pr")) return;
    let cancelled = false;
    rpc
      .call("listInitiativeEnvironments", { projectId: envProjectId })
      .then((result) => {
        if (!cancelled) setEnvironments(result.environments);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [envProjectId, kind, rpc]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = useMemo((): InitiativeSubscriptionConfig | null => {
    switch (kind) {
      case "schedule":
        if (preset === "once") {
          const runAt = new Date(onceAt).getTime();
          return Number.isNaN(runAt) ? null : { schedule: "once", runAt, prompt: prompt.trim() };
        }
        const expression =
          preset === "custom"
            ? customCron.trim()
            : (CRON_PRESETS.find((p) => p.id === preset)?.expression ?? "");
        return expression === "" ? null : { schedule: "cron", expression, prompt: prompt.trim() };
      case "github-ci":
        return repo.trim() === "" || environmentId === ""
          ? null
          : {
              repo: repo.trim(),
              ...(branch.trim() !== "" ? { branch: branch.trim() } : {}),
              environmentId,
            };
      case "github-pr":
        return repo.trim() === "" || environmentId === "" || pr.trim() === ""
          ? null
          : { repo: repo.trim(), pr: Number(pr), environmentId };
      case "slack-channel":
        return channelId.trim() === "" ? null : { channelId: channelId.trim() };
    }
  }, [kind, preset, customCron, onceAt, repo, branch, pr, channelId, environmentId, prompt]);

  const promptRequired = kind === "schedule";
  const canSubmit =
    label.trim() !== "" && config !== null && (!promptRequired || prompt.trim() !== "") && !busy;

  const submit = () => {
    if (!canSubmit || config === null) return;
    setBusy(true);
    setError(null);
    rpc
      .call("upsertSubscription", {
        ...(existing !== null ? { subscriptionId: existing.id } : {}),
        initiativeId: initiative.id,
        kind,
        label: label.trim(),
        prompt: prompt.trim() === "" ? null : prompt.trim(),
        config,
        enabled: existing?.enabled ?? true,
      })
      .then(() => onDone())
      .catch((saveError: unknown) =>
        setError(saveError instanceof Error ? saveError.message : "Save failed"),
      )
      .finally(() => setBusy(false));
  };

  const inputClass =
    "rounded-md border border-border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring";

  return (
    <div className="flex flex-col gap-2.5 p-1" data-subscription-editor="">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">
          {existing === null ? "New subscription" : `Edit ${existing.label}`}
        </span>
        <button
          type="button"
          aria-label="Back"
          onClick={onDone}
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent"
        >
          <Icon name="X" className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-muted-foreground">Kind</span>
        <Select
          value={kind}
          onValueChange={(value) => setKind(value as InitiativeSubscriptionKind)}
          disabled={existing !== null}
        >
          <SelectTrigger className="h-8 w-full" aria-label="Kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(KIND_META) as InitiativeSubscriptionKind[]).map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_META[k].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-muted-foreground">Label</span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="e.g. CI on main"
          className={inputClass}
        />
      </label>
      {kind === "schedule" ? (
        <>
          <div className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-muted-foreground">When</span>
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger className="h-8 w-full" aria-label="Schedule">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRON_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {preset === "custom" ? (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Cron expression</span>
              <input
                value={customCron}
                onChange={(event) => setCustomCron(event.target.value)}
                placeholder="0 9 * * 1-5"
                className={inputClass}
              />
            </label>
          ) : null}
          {preset === "once" ? (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Run at</span>
              <input
                type="datetime-local"
                value={onceAt}
                onChange={(event) => setOnceAt(event.target.value)}
                className={inputClass}
              />
            </label>
          ) : null}
        </>
      ) : null}
      {kind === "github-ci" || kind === "github-pr" ? (
        <>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-muted-foreground">Repository</span>
            <input
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="owner/repo"
              className={inputClass}
            />
          </label>
          {kind === "github-ci" ? (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">
                Branch <span className="font-normal">(optional)</span>
              </span>
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
                className={inputClass}
              />
            </label>
          ) : (
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">PR number</span>
              <input
                value={pr}
                onChange={(event) => setPr(event.target.value)}
                inputMode="numeric"
                placeholder="123"
                className={inputClass}
              />
            </label>
          )}
          <div className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-muted-foreground">Environment</span>
            <Select value={environmentId} onValueChange={setEnvironmentId}>
              <SelectTrigger className="h-8 w-full" aria-label="Environment">
                <SelectValue placeholder="Select environment" />
              </SelectTrigger>
              <SelectContent>
                {environments
                  .filter((environment) => environment.status === "ready")
                  .map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {environment.name ?? environment.id}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </>
      ) : null}
      {kind === "slack-channel" ? (
        <>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-muted-foreground">Channel ID</span>
            <input
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
              placeholder="C0123ABCDEF"
              className={inputClass}
            />
          </label>
        </>
      ) : null}
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-muted-foreground">
          {promptRequired ? "Prompt" : "Coordinator instruction (optional)"}
        </span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={2}
          placeholder={
            kind === "schedule"
              ? "What should the coordinator do when this fires?"
              : "How should the coordinator handle digests from this source?"
          }
          className={cn(inputClass, "resize-none")}
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" disabled={!canSubmit} onClick={submit}>
          {busy ? "Saving…" : existing === null ? "Create" : "Save"}
        </Button>
      </div>
    </div>
  );
}
