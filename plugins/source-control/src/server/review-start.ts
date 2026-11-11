/**
 * "Review with bb": a read-only agent thread that reviews a Change's head and
 * reports its findings with `source_control_report_findings`. Only threads
 * started here get the tool; their bb metadata names the Change. Prompts and
 * playbooks are ported from the code review plugin and live in
 * `instructions/` and `playbooks/`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BbPluginApi,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
} from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { z } from "zod";
import { githubRepo, reviewTag, type ChangeKey } from "../core/ids.ts";
import { parseChangeKey, type ChangeDetail, type ReviewRevision } from "../core/review.ts";
import type { Placement } from "../core/change.ts";
import type { ReviewItems } from "./review-items.ts";
import type { Store } from "./store.ts";

const files = instructionFiles(import.meta.url);

export const REPORT_FINDINGS = "source_control_report_findings";

type StartResult = { ok: true; threadId: string; reused: boolean } | { ok: false; message: string };
type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

const RUNNING = new Set(["pending", "starting", "active", "stopping"]);

// ── Prompt text ────────────────────────────────────────────────────────

/** CommonMark inline code that shows `text` as is, whatever backticks it holds. */
export function inlineCode(text: string): string {
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** A fence longer than any backtick run inside, so the content cannot close it. */
export function fenced(code: string, language = "sh"): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The plugin's playbooks, each as a section: its description, then its checklist. */
function playbooks(): string {
  const dir = join(files.root, "playbooks");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .toSorted()
    .map((name) => {
      const text = readFileSync(join(dir, name), "utf8").trim();
      const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
      const description = /description:\s*(.+)/.exec(front?.[1] ?? "")?.[1]?.trim() ?? "";
      const body = (front ? text.slice(front[0].length) : text).trim().replace(/^# /m, "### ");
      return description ? body.replace(/^(### .*)$/m, `$1\n\nWhen: ${description}`) : body;
    })
    .join("\n\n");
}

const criteria = () => files.read("review-criteria", { playbooks: playbooks() });

/** A host revision's base as the reviewer reads it, and the diff to review. */
export function baseOf(revision: ReviewRevision): { base: string; diff: string } {
  const range = (from: string) => fenced(`git diff ${from}...${revision.head}`);
  if (!revision.base.startsWith("branch:")) {
    return { base: `\`${revision.base}\``, diff: range(revision.base) };
  }
  const name = revision.base.slice("branch:".length);
  if (name === "")
    return {
      base: "the remote's default branch. Find it with `git symbolic-ref --short refs/remotes/origin/HEAD`, else use `origin/main`",
      diff: `${range("<the remote's default branch>")}\n\nUse the remote that points at GitHub if it is not named \`origin\`.`,
    };
  const ref = `origin/${name}`;
  return {
    base: inlineCode(ref),
    diff: `${range(quote(ref))}\n\nUse the remote that points at GitHub if it is not named \`origin\`.`,
  };
}

export function checkoutPrompt(input: {
  branch: string;
  repoName: string;
  placement: Placement;
  revision: ReviewRevision;
  pullRequest: { number: number; url: string } | null;
}): string {
  const { base, diff } = baseOf(input.revision);
  return files.read("review-checkout", {
    branch: inlineCode(input.branch),
    repoName: inlineCode(input.repoName),
    path: inlineCode(input.placement.path),
    machine: input.placement.hostName,
    base,
    head: input.revision.head,
    pullRequest: input.pullRequest
      ? `\n- Pull request: #${input.pullRequest.number}, ${input.pullRequest.url}`
      : "",
    diff,
    criteria: criteria(),
  });
}

export function pullRequestPrompt(input: {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  baseRef: string;
  branch: string;
  head: string;
}): string {
  return files.read("review-pull-request", {
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    title: input.title,
    url: input.url,
    baseBranch: inlineCode(input.baseRef),
    branch: inlineCode(input.branch),
    head: input.head,
    fetch: fenced(
      [
        `git fetch origin 'pull/${input.number}/head' ${quote(input.baseRef)}`,
        `git checkout --detach ${input.head}`,
        `git merge-base ${input.head} ${quote(`origin/${input.baseRef}`)}`,
      ].join("\n"),
    ),
    criteria: criteria(),
  });
}

// ── Starting a review ──────────────────────────────────────────────────

type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>[number];

async function projectFor(bb: BbPluginApi, owner: string, name: string): Promise<Project | null> {
  const projects = await bb.sdk.projects.list();
  return (
    projects.find((project) => {
      const repo = githubRepo(project.gitRemoteUrl);
      return repo?.owner === owner.toLowerCase() && repo.name === name.toLowerCase();
    }) ?? null
  );
}

/**
 * Where an agent works on the Change: in the checkout that has it (reused,
 * since its commits may be nowhere else), else in a new worktree of the
 * project whose remote is the pull request's repository.
 */
export async function changeHome(
  bb: BbPluginApi,
  store: Store,
  key: ChangeKey,
  revision: ReviewRevision,
): Promise<
  { projectId: string; environment: SpawnArgs["environment"]; placement: Placement | null } | string
> {
  const { source } = revision;
  if (source.kind === "host") {
    const placement = store
      .checkouts()
      .find((each) => each.hostId === source.hostId && each.path === source.path);
    if (!placement) return "No thread has this checkout any more.";
    const environment = await bb.sdk.environments.get({ environmentId: placement.environmentId });
    return {
      projectId: environment.projectId,
      environment: { type: "reuse", environmentId: placement.environmentId },
      placement,
    };
  }
  const parsed = parseChangeKey(key);
  if (parsed?.kind !== "gh") return "This Change has no checkout or pull request.";
  const project = await projectFor(bb, parsed.repo.owner, parsed.repo.name);
  if (!project) return `Add ${parsed.repo.owner}/${parsed.repo.name} as a bb project first.`;
  const sourceRow = project.sources.find((each) => each.isDefault) ?? project.sources[0];
  return {
    projectId: project.id,
    // A new worktree, so the agent never moves anyone's checkout.
    environment: {
      type: "host",
      ...(sourceRow ? { hostId: sourceRow.hostId } : {}),
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    },
    placement: null,
  };
}

/** Where the review runs and what it is told. */
async function reviewTarget(
  bb: BbPluginApi,
  store: Store,
  key: ChangeKey,
  detail: Extract<ChangeDetail, { state: "change" }>,
  revision: ReviewRevision,
): Promise<{ projectId: string; environment: SpawnArgs["environment"]; prompt: string } | string> {
  const home = await changeHome(bb, store, key, revision);
  if (typeof home === "string") return home;
  const pr = store.forge(key).read?.value ?? null;
  if (home.placement)
    return {
      projectId: home.projectId,
      environment: home.environment,
      prompt: checkoutPrompt({
        branch: detail.row.branch,
        repoName: detail.row.repo,
        placement: home.placement,
        revision,
        pullRequest: pr && pr.state === "open" ? { number: pr.number, url: pr.url } : null,
      }),
    };
  const parsed = parseChangeKey(key);
  if (parsed?.kind !== "gh" || !pr) return "This Change has no checkout or pull request to review.";
  return {
    projectId: home.projectId,
    environment: home.environment,
    prompt: pullRequestPrompt({
      owner: parsed.repo.owner,
      repo: parsed.repo.name,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      baseRef: pr.baseRef,
      branch: parsed.branch,
      head: revision.head,
    }),
  };
}

export function createReviewStart(deps: {
  bb: BbPluginApi;
  store: Store;
  items: ReviewItems;
  detail: (key: ChangeKey) => ChangeDetail;
  invalidate: (tags: readonly string[]) => void;
  now: () => number;
}) {
  const { bb, store } = deps;
  const starting = new Map<ChangeKey, Promise<StartResult>>();

  /** A review of this head that is still running, if bb says so. */
  const running = async (key: ChangeKey, head: string): Promise<string | null> => {
    const run = store.runs(key).find((each) => each.state === "running" && each.head === head);
    if (!run) return null;
    try {
      const thread = await bb.sdk.threads.get({ threadId: run.threadId });
      if (RUNNING.has(thread.status)) return run.threadId;
    } catch {
      // Gone: start another.
    }
    deps.items.runEnded(run.threadId, true);
    return null;
  };

  const start = async (key: ChangeKey): Promise<StartResult> => {
    const detail = deps.detail(key);
    if (detail.state !== "change" || !detail.revision)
      return { ok: false, message: "This Change has no commits to review yet." };
    const { revision } = detail;
    const reused = await running(key, revision.head);
    if (reused) return { ok: true, threadId: reused, reused: true };
    const target = await reviewTarget(bb, store, key, detail, revision);
    if (typeof target === "string") return { ok: false, message: target };
    const thread = await bb.sdk.threads.spawn({
      projectId: target.projectId,
      environment: target.environment,
      reasoningLevel: "high",
      visibility: "visible",
      title: `Review ${detail.row.number ? `#${detail.row.number}` : detail.row.branch}`,
      pluginMetadata: { kind: "review", changeKey: key, head: revision.head },
      prompt: target.prompt,
    });
    store.putRun(key, {
      threadId: thread.id,
      head: revision.head,
      state: "running",
      startedAt: deps.now(),
      summary: null,
      findings: 0,
    });
    deps.invalidate([reviewTag(key)]);
    return { ok: true, threadId: thread.id, reused: false };
  };

  return {
    /** One start per Change at a time: a double click or a second window joins the first. */
    startReview(key: ChangeKey): Promise<StartResult> {
      const pending = starting.get(key);
      if (pending) return pending;
      const work = start(key)
        .catch((error: unknown): StartResult => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => starting.delete(key));
      starting.set(key, work);
      return work;
    },
  };
}

// ── The findings tool ──────────────────────────────────────────────────

const line = z.number().int().positive();

const parameters = z.strictObject({
  summary: z.string().describe("A short overall assessment of the change."),
  findings: z
    .array(
      z.strictObject({
        priority: z.number().int().min(0).max(3).describe("0 = P0 … 3 = P3."),
        title: z.string().min(1),
        body: z.string(),
        path: z.string().min(1),
        line: line.describe("Last line of the range, numbered on `side`."),
        startLine: line.optional().describe("First line of a multi-line range."),
        side: z
          .enum(["LEFT", "RIGHT"])
          .optional()
          .describe("RIGHT (head, default) or LEFT (base)."),
      }),
    )
    .max(50),
});

/** Only threads Source Control started as reviews get the tool; their metadata names the Change. */
export function reportFindingsEnabled(session: PluginAgentConfigurationContext): boolean {
  const { kind, changeKey } = session.pluginMetadata;
  return kind === "review" && typeof changeKey === "string";
}

export function reportFindingsTool(items: ReviewItems) {
  return {
    name: REPORT_FINDINGS,
    ...files.tool(REPORT_FINDINGS),
    presentation: {
      label: { pending: "Reporting review findings", completed: "Reported review findings" },
    },
    parameters,
    async execute(
      { summary, findings }: z.output<typeof parameters>,
      { threadId }: PluginAgentToolContext,
    ) {
      const saved = items.report(threadId, summary, findings);
      if (!saved)
        throw new Error(
          "This thread is not a Source Control review, so there is nowhere to report to.",
        );
      const count = saved.count === 1 ? "1 finding" : `${saved.count} findings`;
      return `Reported ${count} on ${saved.key}.`;
    },
  };
}
