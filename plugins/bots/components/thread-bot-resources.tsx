import { useState } from "react";
import {
  experimental_InfoSection as InfoSection,
  experimental_useRpcQuery as useRpcQuery,
  Markdown,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb-plugins/ui/button";
import { BOTS_PLUGIN_ID, rpcContract } from "../contract";
import { describeCron, routineStatus } from "../lib/routine-format";
import { DisclosureRow } from "./disclosure-row";

const textClass = "whitespace-pre-wrap text-xs leading-relaxed [overflow-wrap:anywhere]";
/** Markdown at the sidebar's reading size, scrolling inside its own region when long. */
const markdownClass = "bot-sidebar-markdown max-h-80 min-w-0 overflow-auto text-xs";

/** A SKILL.md body without its frontmatter; the row already shows name and description. */
/** MEMORY.md without a leading "# Memory" heading, which would repeat the section label. */
const memoryBody = (content: string) => content.replace(/^\s*#\s+memory\s*\n/i, "").trim();
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
      <output aria-busy="true" aria-label={`Loading ${label}`} className="block space-y-2 py-1">
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
          <div className="min-w-0">
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
    <DisclosureRow title={name} onToggle={setOpen}>
      {description ? (
        <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {description}
        </p>
      ) : null}
      {open ? <SkillContent botId={botId} name={name} /> : null}
    </DisclosureRow>
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
          <div className="min-w-0">
            {query.data.routines.map((routine) => (
              <DisclosureRow
                key={routine.id}
                title={routine.name}
                meta={routineStatus(routine)}
                metaTone={routine.automationError ? "danger" : "muted"}
              >
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {describeCron(routine.cron)}
                  {" · "}
                  {routine.timezone}
                </p>
                <p className={`mt-1.5 ${textClass}`}>{routine.instruction}</p>
                {routine.automationError ? (
                  <p className="mt-1.5 text-xs text-destructive [overflow-wrap:anywhere]">
                    {routine.automationError}
                  </p>
                ) : null}
              </DisclosureRow>
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
          <Markdown content={memoryBody(query.data.content)} className={markdownClass} />
        ) : (
          <p className="text-xs text-muted-foreground">No memories yet.</p>
        )
      ) : null}
    </InfoSection>
  );
}
