import type { Check, Checks, PrRef } from "../../shared/schema.ts";
import type { Gh } from "./gh.ts";
import { type GqlPageInfo, remainingPages, restRepo, rollupState } from "./github.ts";

/*
 * Checks on the pull request's head commit: GitHub check runs (Actions jobs
 * and app checks) and legacy commit statuses, normalized to one shape.
 */

const CONTEXTS = `pageInfo { hasNextPage endCursor }
  nodes {
    __typename
    ... on CheckRun {
      databaseId name status conclusion detailsUrl startedAt completedAt title
      checkSuite { app { name } workflowRun { workflow { name } } }
    }
    ... on StatusContext { context state targetUrl description createdAt }
  }`;

export const CHECKS_QUERY = `query Checks($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) {
        nodes { commit { id statusCheckRollup { state contexts(first: 100) { ${CONTEXTS} } } } }
      }
    }
  }
}`;

export const CHECK_CONTEXTS_QUERY = `query CheckContexts($id: ID!, $after: String!) {
  node(id: $id) {
    ... on Commit { statusCheckRollup { contexts(first: 100, after: $after) { ${CONTEXTS} } } }
  }
}`;

export type GqlCheckContext =
  | {
      __typename: "CheckRun";
      databaseId: number;
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      startedAt: string | null;
      completedAt: string | null;
      title: string | null;
      checkSuite: {
        app: { name: string } | null;
        workflowRun: { workflow: { name: string } } | null;
      } | null;
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: string;
      targetUrl: string | null;
      description: string | null;
      createdAt: string;
    };

type Contexts = { pageInfo: GqlPageInfo; nodes: GqlCheckContext[] };

export type GqlChecks = {
  repository: {
    pullRequest: {
      headRefOid: string;
      commits: {
        nodes: {
          commit: { id: string; statusCheckRollup: { state: string; contexts: Contexts } | null };
        }[];
      };
    };
  };
};

const CONCLUSIONS: Record<string, Check["state"]> = {
  SUCCESS: "success",
  FAILURE: "failure",
  TIMED_OUT: "failure",
  STARTUP_FAILURE: "failure",
  ACTION_REQUIRED: "failure",
  NEUTRAL: "neutral",
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
  STALE: "cancelled",
};

/** An Actions job's id, read from its log URL: other check runs in the same suite have none. */
const JOB_URL = /\/actions\/runs\/\d+\/job\/(\d+)/;

export function mapCheck(node: GqlCheckContext): Check {
  if (node.__typename === "StatusContext") {
    return {
      id: `status:${node.context}`,
      name: node.context,
      workflow: null,
      state: rollupState(node.state) ?? "neutral",
      description: node.description || null,
      detailsUrl: node.targetUrl || null,
      startedAt: node.createdAt,
      completedAt: null,
      jobId: null,
    };
  }
  const suite = node.checkSuite;
  const job = suite?.workflowRun ? JOB_URL.exec(node.detailsUrl ?? "") : null;
  return {
    id: `run:${node.databaseId}`,
    name: node.name,
    workflow: suite?.workflowRun?.workflow.name ?? suite?.app?.name ?? null,
    state:
      node.status === "COMPLETED" ? (CONCLUSIONS[node.conclusion ?? ""] ?? "neutral") : "pending",
    description: node.title || null,
    detailsUrl: node.detailsUrl || null,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    jobId: job ? Number(job[1]) : null,
  };
}

const RANK: Partial<Record<Check["state"], number>> = { failure: 0, pending: 1 };

/** Failures, then checks still running, then the rest; each group by name. */
export function sortChecks(checks: Check[]): Check[] {
  return checks.toSorted(
    (a, b) => (RANK[a.state] ?? 2) - (RANK[b.state] ?? 2) || a.name.localeCompare(b.name),
  );
}

export async function loadChecks(gh: Gh, ref: PrRef): Promise<Checks> {
  const data = (await gh.graphql(CHECKS_QUERY, {
    owner: ref.owner,
    name: ref.repo,
    number: ref.number,
  })) as GqlChecks;
  const { headRefOid, commits } = data.repository.pullRequest;
  const commit = commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup;
  if (!commit || !rollup) return { headRefOid, state: null, checks: [] };
  const contexts = await remainingPages(rollup.contexts, async (after) => {
    const page = (await gh.graphql(CHECK_CONTEXTS_QUERY, { id: commit.id, after })) as {
      node: { statusCheckRollup: { contexts: Contexts } };
    };
    return page.node.statusCheckRollup.contexts;
  });
  return {
    headRefOid,
    state: rollupState(rollup.state),
    checks: sortChecks(contexts.map(mapCheck)),
  };
}

/** Enough to show the failure, short enough to read in the composer before sending. */
export const LOG_LINES = 60;

/* Actions log lines start with a timestamp, and some carry ANSI colour. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// oxlint-disable-next-line no-control-regex -- matching the escape character is the point
const ANSI = /\u001B\[[\d;]*m/g;

/**
 * The end of a failed job's log, where the error is. The log runs on past
 * the failure into post-job cleanup, so it is cut after the last
 * `##[error]` line before the tail is taken.
 */
export function logTail(log: string, lines = LOG_LINES): string {
  const all = log
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(TIMESTAMP, "").replace(ANSI, "").trimEnd());
  const lastError = all.findLastIndex((line) => line.includes("##[error]"));
  const upToFailure = lastError === -1 ? all : all.slice(0, lastError + 1);
  return upToFailure.slice(-lines).join("\n").trim();
}

/**
 * A job's log through the REST API. `gh run view --log-failed` prints
 * nothing for current Actions logs on gh 2.46, so it is not used.
 */
export async function jobLogTail(gh: Gh, ref: PrRef, jobId: number): Promise<string> {
  return logTail(
    await gh.text(["api", `${restRepo(ref.owner, ref.repo)}/actions/jobs/${jobId}/logs`]),
  );
}
