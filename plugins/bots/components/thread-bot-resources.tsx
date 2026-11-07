import { useState, type ReactNode } from "react";
import {
  experimental_InfoSection as InfoSection,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb-plugins/ui/button";
import { BOTS_PLUGIN_ID, rpcContract } from "../contract";
import { describeCron, routineStatus } from "../lib/routine-format";

const textClass =
  "max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-relaxed [overflow-wrap:anywhere]";

/** These reads stay independent: skills need the checkout host; memory does not. */
export function ThreadBotResources({ botId }: { botId: string }) {
  return (
    <>
      <BotSkills botId={botId} />
      <BotRoutines botId={botId} />
      <BotMemory botId={botId} />
    </>
  );
}

function ReadStatus({
  loading,
  failed,
  cached,
  label,
  retry,
}: {
  loading: boolean;
  failed: boolean;
  cached: boolean;
  label: string;
  retry: () => void;
}) {
  if (loading)
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={`Loading ${label}`}
        className="space-y-2 py-1"
      >
        <span className="sr-only">Loading {label}…</span>
        <div className="h-4 animate-pulse rounded bg-muted/60" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted/60" />
      </div>
    );
  if (!failed) return null;
  return (
    <div
      role="alert"
      className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground"
    >
      <span>
        {cached ? `Could not refresh ${label}. Showing saved data.` : `Could not load ${label}.`}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-xs"
        onClick={retry}
      >
        Retry
      </Button>
    </div>
  );
}

function ResourceItem({
  title,
  children,
  detail,
}: {
  title: string;
  children: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <details className="min-w-0 py-1">
      <summary className="cursor-pointer rounded-sm text-xs text-foreground [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {title}
      </summary>
      {detail}
      <div className="mt-2 min-w-0">{children}</div>
    </details>
  );
}

function BotSkills({ botId }: { botId: string }) {
  const query = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "skills_list",
    input: { botId },
  });
  return (
    <InfoSection label="Skills">
      <ReadStatus
        label="skills"
        loading={!query.data && query.error === null}
        failed={query.error !== null}
        cached={Boolean(query.data)}
        retry={() => void query.refetch()}
      />
      {query.data ? (
        query.data.skills.length ? (
          <div className="min-w-0 divide-y divide-border/50">
            {query.data.skills.map((skill) => (
              <Skill key={skill.name} botId={botId} {...skill} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No skills yet.</p>
        )
      ) : null}
    </InfoSection>
  );
}

function Skill({ botId, name, description }: { botId: string; name: string; description: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="min-w-0 py-1" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-sm text-xs text-foreground [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {name}
      </summary>
      {description ? (
        <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{description}</p>
      ) : null}
      {open ? <SkillContent botId={botId} name={name} /> : null}
    </details>
  );
}

function SkillContent({ botId, name }: { botId: string; name: string }) {
  const query = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "skill_read",
    input: { botId, name },
  });
  return (
    <div className="mt-2 min-w-0">
      <ReadStatus
        label={name}
        loading={!query.data && query.error === null}
        failed={query.error !== null}
        cached={Boolean(query.data)}
        retry={() => void query.refetch()}
      />
      {query.data ? (
        <pre className={`${textClass} rounded-md bg-muted/50 p-2 font-mono text-[11px]`}>
          {query.data.content}
        </pre>
      ) : null}
    </div>
  );
}

function BotRoutines({ botId }: { botId: string }) {
  const query = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "routines_list",
    input: { botId },
  });
  return (
    <InfoSection label="Routines">
      <ReadStatus
        label="routines"
        loading={!query.data && query.error === null}
        failed={query.error !== null}
        cached={Boolean(query.data)}
        retry={() => void query.refetch()}
      />
      {query.data ? (
        query.data.routines.length ? (
          <div className="min-w-0 divide-y divide-border/50">
            {query.data.routines.map((routine) => (
              <ResourceItem
                key={routine.id}
                title={routine.name}
                detail={
                  <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {routineStatus(routine)}
                    {" · "}
                    {describeCron(routine.cron)}
                    {" · "}
                    {routine.timezone}
                  </p>
                }
              >
                <p className={textClass}>{routine.instruction}</p>
                {routine.automationError ? (
                  <p className="mt-1 text-xs text-destructive [overflow-wrap:anywhere]">
                    {routine.automationError}
                  </p>
                ) : null}
              </ResourceItem>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No routines yet.</p>
        )
      ) : null}
    </InfoSection>
  );
}

function BotMemory({ botId }: { botId: string }) {
  const query = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "state_read",
    input: { botId, file: "MEMORY.md" },
  });
  return (
    <InfoSection label="Memory">
      <ReadStatus
        label="memory"
        loading={!query.data && query.error === null}
        failed={query.error !== null}
        cached={Boolean(query.data)}
        retry={() => void query.refetch()}
      />
      {query.data ? (
        query.data.content.trim() ? (
          <p className={textClass}>{query.data.content}</p>
        ) : (
          <p className="text-xs text-muted-foreground">No memories yet.</p>
        )
      ) : null}
    </InfoSection>
  );
}
