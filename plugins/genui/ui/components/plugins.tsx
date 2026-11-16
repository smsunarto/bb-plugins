// Plugins: the BB plugins a handoff says it installed, reloaded or removed
// (project_plugins), each beside what BB runs now: its name, version, where
// BB loads it from, and its status. The reply supplies only the claim; a
// claim BB contradicts (reloaded but not running, removed but still
// installed) or that needs the reader (a disabled plugin, a skipped reload
// with no reason) is marked in the row and counted in the header. BB reports no
// load time, so a row says the plugin runs, not that the reload happened.
// Needs no thread. It reads once when it mounts and polls, with backoff, only
// while visible and a plugin is starting.
import { useMemo } from "react";
import { experimental_PluginIcon as PluginIcon, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  parsePluginClaims,
  PLUGIN_ACTION_LABEL,
  pluginRows,
  pluginSettling,
  type PluginClaim,
  type PluginRow,
} from "../../core/plugins";
import type { PluginsResult } from "../../core/project";
import type { rpcContract } from "../../server";
import { formatNumber, TONE_TEXT, type Props } from "../values";
import { ErrorLine } from "./display";
import { RISE, useEntrance } from "./motion";
import {
  FailureLine,
  Freshness,
  LoadingRows,
  Panel,
  useNow,
  useProjectQuery,
  useVisible,
} from "./projectKit";
import { LiveDot } from "./threads";
import { Badge } from "@/components/ui/badge";

export function Plugins({ props }: { props: Props }) {
  const claims = useMemo(() => parsePluginClaims(props.items), [props.items]);
  if (!claims.ok) return <ErrorLine message={claims.error} />;
  return <PluginsPanel claims={claims.value} />;
}

function PluginsPanel({ claims }: { claims: readonly PluginClaim[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [ref, visible] = useVisible<HTMLDivElement>();
  const ids = useMemo(() => claims.map((claim) => claim.id), [claims]);
  const { query, refresh } = useProjectQuery<PluginsResult>(
    `plugins\0${ids.join("\0")}`,
    () => rpc.call("project_plugins", { ids }),
    { visible, live: (answer) => answer.ok && answer.plugins.some(pluginSettling) },
  );
  const now = useNow(15_000);
  const answer = query.status === "ready" ? query.answer : null;
  const view = answer?.ok ? answer : null;
  const rows = useMemo(
    () => (view === null ? [] : pluginRows(claims, view.plugins)),
    [claims, view],
  );
  const problems = rows.filter((row) => row.problem !== null);
  const worst = problems.some((row) => row.tone === "bad") ? "bad" : "warn";
  return (
    <div ref={ref} className="min-w-0">
      <Panel
        label="Plugins"
        header={
          <>
            <span className="flex min-w-0 items-center gap-1">
              <Icon name="Puzzle" aria-hidden className="size-3.5 shrink-0" />
              <span className="font-medium text-foreground">Plugins</span>
              <span className="tabular-nums">{formatNumber(claims.length)}</span>
            </span>
            {problems.length > 0 ? (
              <span className={cn("tabular-nums", TONE_TEXT[worst])}>
                {problems.length} {problems.length === 1 ? "needs" : "need"} attention
              </span>
            ) : null}
            {view === null ? null : (
              <Freshness
                at={view.fetchedAt}
                stored={false}
                refreshing={query.status === "ready" && query.refreshing}
                onRefresh={refresh}
                now={now}
              />
            )}
          </>
        }
      >
        {answer === null ? (
          <LoadingRows label="Loading plugins" rows={Math.min(claims.length, 4)} />
        ) : !answer.ok ? (
          <FailureLine failure={answer} />
        ) : (
          <ul className="m-0 flex min-w-0 list-none flex-col p-0">
            {rows.map((row) => (
              <PluginLine key={row.claim.id} row={row} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function PluginLine({ row }: { row: PluginRow }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const { claim, state } = row;
  const name = state.found ? state.name : claim.id;
  return (
    <li
      ref={rise}
      className="flex min-w-0 items-start gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
    >
      {state.found ? (
        <PluginIcon
          pluginId={state.id}
          icon={state.icon}
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <Icon
          name="Puzzle"
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground/60"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "min-w-0 truncate text-[13px] font-medium leading-5 text-foreground",
              !state.found && "font-mono text-xs",
            )}
          >
            {name}
          </span>
          {state.found && state.name !== state.id ? (
            <code className="min-w-0 truncate font-mono text-[11px] leading-4 text-muted-foreground">
              {state.id}
            </code>
          ) : null}
          {state.found && state.version !== null ? (
            <span className="shrink-0 text-[11px] leading-4 tabular-nums text-muted-foreground">
              v{state.version}
            </span>
          ) : null}
          <Badge
            variant={claim.action === "not-reloaded" ? "warning" : "secondary"}
            className="ml-auto font-medium"
          >
            {PLUGIN_ACTION_LABEL[claim.action]}
          </Badge>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] leading-4 text-muted-foreground">
          <span className={cn("flex shrink-0 items-center gap-1 font-medium", TONE_TEXT[row.tone])}>
            <LiveDot tone={row.tone} live={pluginSettling(state)} />
            {row.stateLabel}
          </span>
          {state.found ? (
            <>
              <span aria-hidden>·</span>
              <span title={state.sourceNotice ?? state.source} className="min-w-0 truncate">
                {state.source}
              </span>
            </>
          ) : null}
        </div>
        {row.problem === null ? null : (
          <p
            className={cn(
              "m-0 min-w-0 text-xs leading-5 [overflow-wrap:anywhere]",
              TONE_TEXT[row.tone],
            )}
          >
            {row.problem}
          </p>
        )}
        {claim.note === null ? null : (
          <p className="m-0 min-w-0 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {claim.note}
          </p>
        )}
      </div>
    </li>
  );
}
