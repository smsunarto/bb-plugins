/**
 * Create PR: the agent's job, not a form's. A visible child of the thread,
 * on the thread's checkout, reads the branch, writes the title and
 * description, and opens the pull request with the checkout's own driver
 * (`but pr new`, or native Git and `gh`). Ported from gitbutler
 * (`src/server/rpc/request-review.ts`, `lib/review-requests.ts`,
 * `lib/prompts.ts`), with its prompts unchanged.
 *
 * One child per branch and checkout: which child is for which branch is kept
 * in plugin KV, so a second Create PR while one runs returns that one.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { findBranch, type Placement, type WorkspaceValue } from "../core/change.ts";
import { message } from "./host-calls.ts";
import { fenced, quote } from "./review-start.ts";
import type { Store } from "./store.ts";

const files = instructionFiles(import.meta.url);

const RUNNING = new Set(["pending", "starting", "active", "stopping"]);

export type PublishRequest = { branch: string; threadId: string; running: boolean };
export type PublishResult = { ok: true; threadId: string } | { ok: false; message: string };

type Entry = { branch: string; threadId: string };

const kvKey = ({ hostId, path }: Placement) => `publish:${hostId}:${path}`;

/** What the PR child is told: gitbutler's prompt for the checkout's driver, its commands filled in. */
export function publishPrompt(
  branch: string,
  path: string,
  provider: WorkspaceValue["provider"],
): string {
  const name = quote(branch);
  if (provider === "git")
    return files.read("create-pr-git", {
      show: fenced(`cd ${quote(path)}
git status --short --branch
git log --oneline --decorate -20 ${name}
git diff HEAD`),
      configuration: fenced(`git config --get ${quote(`branch.${branch}.pushRemote`)}
git config --get 'remote.pushDefault'
git config --get 'gitbutler.project.pushremote'
git config --get ${quote(`branch.${branch}.remote`)}
git config --get ${quote(`branch.${branch}.merge`)}
git config --get 'gitbutler.project.targetref'
git for-each-ref --format='%(refname) %(upstream)' ${quote(`refs/heads/${branch}`)}
git remote`),
    });
  return files.read("create-pr", {
    show: fenced(`cd ${quote(path)}\nbut show ${name}`),
    prNew: fenced(`but pr new ${name} -F <file>`),
  });
}

/** The SDK's `BbHttpError` carries the HTTP status. */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

export function createPublish(deps: { bb: BbPluginApi; store: Store }) {
  const { bb, store } = deps;
  /** Requests for one checkout take turns: their records share one KV entry. */
  const claims = new Map<string, Promise<PublishResult>>();

  /**
   * A child as the tab shows it, or null once deleted, or archived and
   * stopped. Any failure but "not found" is thrown, so a second child never
   * starts beside one still at work.
   */
  async function live(threadId: string): Promise<PublishRequest["running"] | null> {
    const child = await bb.sdk.threads.get({ threadId }).catch((error: unknown) => {
      if (isNotFound(error)) return null;
      throw error;
    });
    if (!child || child.deletedAt != null) return null;
    const running = RUNNING.has(child.status) || (child.queuedMessageCount ?? 0) > 0;
    if (child.archivedAt != null && !running) return null;
    return running;
  }

  async function requestsAt(placement: Placement): Promise<PublishRequest[]> {
    const entries = (await bb.storage.kv.get<Entry[]>(kvKey(placement))) ?? [];
    const found = await Promise.all(
      entries.map(async (entry) => {
        const running = await live(entry.threadId);
        return running === null
          ? null
          : { branch: entry.branch, threadId: entry.threadId, running };
      }),
    );
    return found.filter((request) => request !== null);
  }

  /** Where the thread's branch is, and why Create PR cannot start there, if it cannot. */
  function locate(
    threadId: string,
    branchName: string,
    head: string,
  ): { refused: string } | { refused: null; placement: Placement; workspace: WorkspaceValue } {
    const where = store.placement(threadId);
    if (where?.state !== "checkout") return { refused: "This thread has no checkout." };
    const workspace = store.local(where.placement.hostId, where.placement.path).read?.value;
    const branch = workspace ? findBranch(workspace, branchName) : null;
    if (!workspace || !branch)
      return { refused: `${branchName} is not in this checkout any more.` };
    if (branch.head !== head)
      return { refused: "The branch changed since you looked. Review it and try again." };
    if (workspace.provider === "git" && workspace.checkedOut !== branchName)
      return { refused: `${branchName} is no longer checked out here. Refresh and try again.` };
    return { refused: null, placement: where.placement, workspace };
  }

  async function spawn(
    threadId: string,
    placement: Placement,
    workspace: WorkspaceValue,
    branch: string,
  ) {
    const parent = await bb.sdk.threads.get({ threadId });
    const child = await bb.sdk.threads.spawn({
      projectId: parent.projectId,
      environment: { type: "reuse", environmentId: placement.environmentId },
      providerId: parent.providerId,
      parentThreadId: threadId,
      visibility: "visible",
      title: `Create PR for ${branch}`,
      pluginMetadata: { kind: "publish", branch, hostId: placement.hostId, path: placement.path },
      prompt: publishPrompt(branch, placement.path, workspace.provider),
    });
    const entries = (await bb.storage.kv.get<Entry[]>(kvKey(placement))) ?? [];
    await bb.storage.kv.set(kvKey(placement), [
      ...entries.filter((entry) => entry.branch !== branch),
      { branch, threadId: child.id },
    ]);
    return child.id;
  }

  return {
    /** The Create PR children still around for the thread's checkout. */
    async requests(threadId: string): Promise<PublishRequest[]> {
      const where = store.placement(threadId);
      if (where?.state !== "checkout") return [];
      return requestsAt(where.placement);
    },

    /**
     * Starts the PR child for `branch` at `head`, or returns the one already
     * running for it. Refused when the branch moved or left the checkout.
     */
    create(threadId: string, branch: string, head: string): Promise<PublishResult> {
      const found = locate(threadId, branch, head);
      if (found.refused !== null) return Promise.resolve({ ok: false, message: found.refused });
      const { placement, workspace } = found;
      const key = kvKey(placement);
      const claim = (claims.get(key) ?? Promise.resolve(null))
        .catch(() => null)
        .then(async (): Promise<PublishResult> => {
          try {
            const running = (await requestsAt(placement)).find(
              (request) => request.branch === branch && request.running,
            );
            if (running) return { ok: true, threadId: running.threadId };
            return { ok: true, threadId: await spawn(threadId, placement, workspace, branch) };
          } catch (error) {
            return { ok: false, message: message(error) };
          }
        });
      claims.set(key, claim);
      void claim.then(() => claims.get(key) === claim && claims.delete(key));
      return claim;
    },
  };
}

export type Publish = ReturnType<typeof createPublish>;
