import { useState } from "react";
import {
  experimental_InfoSection as InfoSection,
  experimental_useRpcQuery as useRpcQuery,
  Markdown,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb-plugins/ui/button";
import { BOTS_PLUGIN_ID, rpcContract } from "../contract";
import { describeCron, routineStatus } from "../lib/routine-format";
import { CardToggle, cardTextClass, ClampedText, ResourceCard } from "./resource-card";

const textClass = `whitespace-pre-wrap ${cardTextClass}`;
/** "America/Los_Angeles" as "Los Angeles": the city is what a reader recognises. */
const zoneCity = (timezone: string) => timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;
/** Markdown at the sidebar's reading size, scrolling inside its own region when long. */
const markdownClass = "bot-sidebar-markdown max-h-80 min-w-0 overflow-auto text-xs";

/** MEMORY.md without a leading "# Memory" heading, which would repeat the section label. */
const memoryBody = (content: string) => content.replace(/^\s*#\s+memory\s*\n/i, "").trim();
/** A SKILL.md body without its frontmatter; the card already shows name and description. */
const skillBody = (content: string) =>
  content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

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
      <output aria-busy="true" aria-label={`Loading ${label}`} className="flex flex-col gap-2 py-1">
        <span className="sr-only">Loading {label}…</span>
        <span className="block h-4 animate-pulse rounded bg-muted/60" />
        <span className="block h-4 w-2/3 animate-pulse rounded bg-muted/60" />
      </output>
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

function BotSkills({ botId }: { botId: string }) {
  const query = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "skills_list",
    input: { botId },
  });
  return (
    <InfoSection label="Skills" count={query.data?.skills.length || undefined}>
      <ReadStatus
        label="skills"
        loading={!query.data && query.error === null}
        failed={query.error !== null}
        cached={Boolean(query.data)}
        retry={() => void query.refetch()}
      />
      {query.data ? (
        query.data.skills.length ? (
          <div className="flex min-w-0 flex-col gap-2">
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
    <ResourceCard title={name}>
      {description ? <p className={cardTextClass}>{description}</p> : null}
      {open ? <SkillContent botId={botId} name={name} /> : null}
      <CardToggle open={open} onClick={() => setOpen(!open)}>
        {open ? "Hide SKILL.md" : "Read SKILL.md"}
      </CardToggle>
    </ResourceCard>
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
    <div className="w-full min-w-0 border-t border-border/60 pt-2">
      <ReadStatus
        label={name}
        loading={!query.data && query.error === null}
        failed={query.error !== null}
        cached={Boolean(query.data)}
        retry={() => void query.refetch()}
      />
      {query.data ? (
        <Markdown content={skillBody(query.data.content)} className={markdownClass} />
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
    <InfoSection label="Routines" count={query.data?.routines.length || undefined}>
      <ReadStatus
        label="routines"
        loading={!query.data && query.error === null}
        failed={query.error !== null}
        cached={Boolean(query.data)}
        retry={() => void query.refetch()}
      />
      {query.data ? (
        query.data.routines.length ? (
          <div className="flex min-w-0 flex-col gap-2">
            {query.data.routines.map((routine) => (
              <ResourceCard
                key={routine.id}
                title={routine.name}
                subtitle={
                  <>
                    {describeCron(routine.cron)}
                    {" · "}
                    <span title={routine.timezone} className="whitespace-nowrap">
                      {zoneCity(routine.timezone)}
                    </span>
                  </>
                }
                meta={routineStatus(routine)}
                metaTone={routine.automationError ? "danger" : "muted"}
              >
                <ClampedText text={routine.instruction} className={textClass} />
                {routine.automationError ? (
                  <p className="text-xs leading-[1.55] text-destructive [overflow-wrap:anywhere]">
                    {routine.automationError}
                  </p>
                ) : null}
              </ResourceCard>
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
          <div className="min-w-0 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
            <Markdown content={memoryBody(query.data.content)} className={markdownClass} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No memories yet.</p>
        )
      ) : null}
    </InfoSection>
  );
}
