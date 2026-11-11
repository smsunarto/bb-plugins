import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { askTag, type ChangeKey } from "../core/ids.ts";
import type { ChangeDetail, ReviewRevision } from "../core/review.ts";
import { guideDiff } from "./guides.ts";
import { message } from "./host-calls.ts";
import { changeHome, fenced, inlineCode } from "./review-start.ts";
import type { Store } from "./store.ts";

const files = instructionFiles(import.meta.url);

export type AskResult = { ok: true; threadId: string } | { ok: false; message: string };
export type Question = {
  key: ChangeKey;
  text: string;
  path?: string;
  line?: number;
  old?: boolean;
};

/**
 * Ask threads run in "Approve for me": the workspace sandbox, with requests
 * reviewed automatically. bb has no read-only mode. Accept Edits is narrower
 * but stops read-only `git` with quoted arguments for the user's approval,
 * which a side question should not need; Full Access drops the sandbox. So
 * "do not modify" stays an instruction, and nothing runs outside the sandbox.
 */
const ASK_PERMISSION = "auto";

const TOOL_NAMES = { git: "Git", gh: "the GitHub CLI", but: "the GitButler CLI" } as const;

/** The question as the thread shows it: the line it was asked from, then the text. */
export function questionText({ text, path, line, old }: Question): string {
  if (!path) return text;
  const where = inlineCode(line ? `${path}:${line}` : path);
  return `About ${where}${line && old ? " before the change" : ""}:\n\n${text}`;
}

/** What the Ask thread is told, agent-only: which Change, at which head, and where to read it. */
export function askContext(
  detail: Extract<ChangeDetail, { state: "change" }>,
  revision: ReviewRevision,
  checkout: string | null,
): string {
  const { row } = detail;
  const where = checkout
    ? [
        `- Checkout: ${inlineCode(checkout)}`,
        "",
        "This checkout is someone's working copy and may hold their other work. The change is this diff:",
        "",
        fenced(guideDiff(revision)),
      ].join("\n")
    : row.number
      ? `- Pull request: #${row.number}${row.url ? `, ${row.url}` : ""}. Fetch its head with \`git fetch origin pull/${row.number}/head\`.`
      : "";
  return files.read("ask-context", {
    change: row.number ? `#${row.number} (${inlineCode(row.branch)})` : inlineCode(row.branch),
    repoName: row.repo,
    branch: row.branch,
    head: revision.head,
    where,
  });
}

/**
 * The Change's Ask thread: a hidden fork of its owning thread made on the
 * first question, one per Change, reused by every client.
 */
export function createAsk(deps: {
  bb: BbPluginApi;
  store: Store;
  detail: (key: ChangeKey) => ChangeDetail;
  /** Threads on the Change's branch. */
  owners: (key: ChangeKey) => string[];
  invalidate: (tags: readonly string[]) => void;
  now: () => number;
}) {
  const { bb, store } = deps;
  /** First questions in flight, by Change: a second one waits for the same fork. */
  const forking = new Map<ChangeKey, Promise<string>>();

  const send = (threadId: string, text: string) =>
    bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
    });

  async function create(question: Question): Promise<string> {
    const { key } = question;
    const detail = deps.detail(key);
    if (detail.state !== "change" || !detail.revision)
      throw new Error("This Change has no revision to ask about yet.");
    const { revision } = detail;
    const text = questionText(question);
    const title = `Ask about ${detail.row.number ? `#${detail.row.number}` : detail.row.branch}`;
    const pluginMetadata = { kind: "ask", changeKey: key };
    const owners = deps.owners(key);
    if (owners.length === 1) {
      const owner = owners[0]!;
      const where = store.placement(owner);
      const checkout = where?.state === "checkout" ? where.placement.path : null;
      const thread = await bb.sdk.threads.fork({
        sourceThreadId: owner,
        visibility: "hidden",
        permissionMode: ASK_PERMISSION,
        title,
        pluginMetadata,
        agentContextSeed: [
          {
            type: "text",
            text: askContext(detail, revision, checkout),
            mentions: [],
            visibility: "agent-only",
          },
        ],
        input: [{ type: "text", text, mentions: [] }],
      });
      return thread.id;
    }
    // No owning thread (a pull request only) or several: a hidden thread in the Change's project.
    const home = await changeHome(bb, store, key, revision);
    if (typeof home === "string") throw new Error(home);
    const thread = await bb.sdk.threads.spawn({
      projectId: home.projectId,
      environment: home.environment,
      visibility: "hidden",
      permissionMode: ASK_PERMISSION,
      title,
      pluginMetadata,
      input: [
        {
          type: "text",
          text: askContext(detail, revision, home.placement?.path ?? null),
          mentions: [],
          visibility: "agent-only",
        },
        { type: "text", text, mentions: [] },
      ],
    });
    return thread.id;
  }

  return {
    read(keys: readonly string[]): Record<string, { threadId: string | null }> {
      return Object.fromEntries(
        keys.map((key) => [key, { threadId: store.askThread(key as ChangeKey) }]),
      );
    },

    async ask(question: Question): Promise<AskResult> {
      const { key } = question;
      try {
        const stored = store.askThread(key);
        if (stored) {
          await send(stored, questionText(question));
          return { ok: true, threadId: stored };
        }
        const pending = forking.get(key);
        if (pending) {
          const threadId = await pending;
          await send(threadId, questionText(question));
          return { ok: true, threadId };
        }
        const made = create(question).then((threadId) => {
          store.setAskThread(key, threadId, deps.now());
          deps.invalidate([askTag(key)]);
          return threadId;
        });
        forking.set(key, made);
        try {
          return { ok: true, threadId: await made };
        } finally {
          forking.delete(key);
        }
      } catch (error) {
        return { ok: false, message: message(error) };
      }
    },

    /** "Open as full thread": the Ask thread becomes an ordinary visible thread. */
    async openAsThread(key: ChangeKey): Promise<AskResult> {
      const threadId = store.askThread(key);
      if (!threadId) return { ok: false, message: "Ask a question first." };
      try {
        await bb.sdk.threads.update({ threadId, visibility: "visible" });
        return { ok: true, threadId };
      } catch (error) {
        return { ok: false, message: message(error) };
      }
    },

    /** A thread on the checkout's host, asked to install the tool its read is missing. */
    async toFix(threadId: string): Promise<AskResult> {
      const where = store.placement(threadId);
      if (where?.state !== "checkout")
        return { ok: false, message: "This thread has no checkout." };
      const { placement } = where;
      const missing = store.local(placement.hostId, placement.path).problem;
      if (missing?.kind !== "tool-missing")
        return { ok: false, message: "No tool is missing from this checkout." };
      try {
        const environment = await bb.sdk.environments.get({
          environmentId: placement.environmentId,
        });
        const thread = await bb.sdk.threads.spawn({
          projectId: environment.projectId,
          environment: { type: "reuse", environmentId: placement.environmentId },
          visibility: "visible",
          title: `Install ${missing.tool} on ${placement.hostName}`,
          pluginMetadata: { kind: "install", tool: missing.tool, hostId: placement.hostId },
          prompt: files.read("install-tool", {
            path: inlineCode(placement.path),
            tool: missing.tool,
            toolName: TOOL_NAMES[missing.tool],
            detail: missing.detail,
          }),
        });
        return { ok: true, threadId: thread.id };
      } catch (error) {
        return { ok: false, message: message(error) };
      }
    },
  };
}

export type Ask = ReturnType<typeof createAsk>;
