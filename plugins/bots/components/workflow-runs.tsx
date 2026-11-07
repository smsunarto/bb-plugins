import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "./ui/icon";
import { BOTS_PLUGIN_ID, rpcContract } from "../contract";
import {
  workflowRunsByOwner,
  workflowRunSummary,
  type WorkflowAgentStatus,
  type WorkflowRun,
} from "../lib/workflow-runs";

export interface WorkflowRunsState {
  byOwner: ReadonlyMap<string, readonly WorkflowRun[]>;
}

const NO_INPUT = {};
const NO_RUNS: readonly WorkflowRun[] = [];
export const WorkflowRunsContext = createContext<WorkflowRunsState>({ byOwner: new Map() });

/** Live BB workflow runs by the conversation that started them; off while there are no bots. */
export function useWorkflowRunsData(enabled: boolean): WorkflowRunsState {
  const { data } = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "workflow_runs",
    input: NO_INPUT,
    enabled,
  });
  return useMemo(
    () => ({ byOwner: workflowRunsByOwner(enabled ? (data?.runs ?? NO_RUNS) : NO_RUNS) }),
    [data, enabled],
  );
}

const GLYPH: Record<
  WorkflowAgentStatus,
  "runtime" | "waiting-for-input" | "unread-error" | "none"
> = {
  working: "runtime",
  waiting: "waiting-for-input",
  error: "unread-error",
  idle: "none",
};

/**
 * The live workflow runs a bot conversation started, as virtual child rows
 * under its card. A run is not a thread; opening it lists its agent threads.
 */
export function BotWorkflowRuns({
  threadId,
  depth,
  activeThreadId,
  onNavigate,
}: {
  threadId: string;
  depth: number;
  activeThreadId: string | null;
  onNavigate: () => void;
}) {
  const runs = useContext(WorkflowRunsContext).byOwner.get(threadId);
  if (runs === undefined || runs.length === 0) return null;
  return (
    <ul className="gtd-workflow-runs" style={{ "--gtd-depth": depth + 1 } as CSSProperties}>
      {runs.map((run) => (
        <WorkflowRunRow
          key={run.key}
          run={run}
          activeThreadId={activeThreadId}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

function WorkflowRunRow({
  run,
  activeThreadId,
  onNavigate,
}: {
  run: WorkflowRun;
  activeThreadId: string | null;
  onNavigate: () => void;
}) {
  const navigate = useBbNavigate();
  const containsActive = run.agents.some((agent) => agent.threadId === activeThreadId);
  const [expanded, setExpanded] = useState(containsActive);
  useEffect(() => {
    if (containsActive) setExpanded(true);
  }, [containsActive]);
  const listId = useId();
  const summary = workflowRunSummary(run);
  const label = `${run.name} workflow, ${summary}`;
  return (
    <li className="gtd-workflow-run" data-workflow-status={run.status}>
      <button
        type="button"
        className="gtd-workflow-row"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={`${expanded ? "Hide" : "Show"} agents: ${label}`}
        title={run.runId ? `${label} · ${run.runId}` : label}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon name="ChevronDown" className={expanded ? "size-3" : "size-3 -rotate-90"} />
        <ThreadStatusGlyph
          indicator={run.status === "working" ? "workflow" : GLYPH[run.status]}
          size="compact"
        />
        <span className="gtd-workflow-name">{run.name}</span>
        <span className="gtd-workflow-count">{summary}</span>
      </button>
      {expanded ? (
        <ul id={listId}>
          {run.agents.map((agent) => (
            <li key={agent.threadId}>
              <a
                href={`#thread-${agent.threadId}`}
                className="gtd-workflow-row gtd-workflow-agent"
                aria-current={agent.threadId === activeThreadId ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  navigate.toThread(agent.threadId, { split: event.metaKey || event.ctrlKey });
                  onNavigate();
                }}
              >
                <ThreadStatusGlyph indicator={GLYPH[agent.status]} size="compact" />
                <span className="gtd-workflow-name">{agent.title}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
