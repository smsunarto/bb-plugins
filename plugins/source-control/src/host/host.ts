/**
 * The checkout host's entry: each checkout's workspace from its provider
 * (plain git or GitButler), its patches, revision-pinned writes, a signal
 * when a watched checkout changes, and GitHub reads when this host is the
 * forge site for a change.
 */
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import {
  sourceControlHostContract,
  sourceControlHostSignals,
  type ForgeAccount,
  type HostFailure,
} from "../contract/host.ts";
import { execGh } from "../forge/exec-gh.ts";
import {
  accountExec,
  GhError,
  readAccounts,
  readPullRequest,
  setDraftAt,
  submitReviewAt,
} from "../forge/github.ts";
import type { Checkout } from "./checkout.ts";
import { runBut } from "./cli.ts";
import { readBaseHistory } from "./history.ts";
import { parseOplog } from "./parse.ts";
import { forget, share } from "./memo.ts";
import { act, hostFailure, problemOf, providers, resolveCheckout } from "./providers.ts";
import { rangeCommits, rangeFiles, rangePatches, resolveBase } from "./range.ts";
import { readCheckoutFiles, readCheckoutPatches, readCheckoutStatus } from "./checkout-reads.ts";
import { mergeAt } from "../forge/merge.ts";
import { runReviewRead } from "../forge/review.ts";
import { changed, keepWatching, renew, stopAll } from "./repository-state.ts";

type Context = ExperimentalHostRpcContext<typeof sourceControlHostSignals>;

/** `gh` as the account the server chose for the repository. */
const asAccount = accountExec(execGh, Date.now);
const ghFor = (account: ForgeAccount) =>
  account ? asAccount(account.login, account.active) : execGh;

function ghFailure(error: unknown): HostFailure {
  if (error instanceof GhError) {
    const code = error.code === "gh-missing" ? "gh-missing" : error.code;
    return { code, message: error.message };
  }
  return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}

/** Keeps the checkout watched under the name the server gave it. A watch that fails changes nothing. */
async function watch(name: string, checkout: Checkout, context: Context): Promise<void> {
  const { path: real, gitDir, commonDir } = checkout;
  await keepWatching({ name, real, gitDir, commonDir }, context).catch((error: unknown) => {
    if (context.signal.aborted) throw error;
  });
}

/**
 * The last write queued on each shared Git directory. Linked checkouts share
 * refs, so they share this queue. A write's checks only hold until another
 * write lands, so one repository's writes run one at a time, checks included.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function oneAtATime<T>(commonDir: string, write: () => Promise<T>): Promise<T> {
  const result = (writeQueues.get(commonDir) ?? Promise.resolve()).then(write);
  // A failed write still frees the repository, and the last one out removes its entry.
  const queue: Promise<unknown> = result
    .catch(() => undefined)
    .finally(() => {
      if (writeQueues.get(commonDir) === queue) writeQueues.delete(commonDir);
    });
  writeQueues.set(commonDir, queue);
  return result;
}

export default experimental_defineHostEntry({
  contract: sourceControlHostContract,
  experimental_signals: sourceControlHostSignals,
  handlers: {
    async workspace({ path, readAs }, context) {
      const { signal } = context;
      try {
        const resolved = await resolveCheckout(path, readAs, signal);
        if (resolved.state === "not-git")
          return { ok: true as const, value: { state: "not-git" as const, path } };
        const { checkout } = resolved;
        if (resolved.state === "detached") {
          await watch(path, checkout, context);
          return { ok: true as const, value: { state: "detached" as const, path: checkout.path } };
        }
        const { provider } = resolved;
        // Readers asking at once share one read.
        const value = await share(`${provider}\0${checkout.path}`, signal, (shared) =>
          providers[provider].read(checkout, shared),
        );
        await watch(path, checkout, context);
        return { ok: true as const, value: { state: "workspace" as const, value } };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: hostFailure(error) };
      }
    },

    async patches({ path, readAs, source }, { signal }) {
      try {
        const resolved = await resolveCheckout(path, readAs, signal);
        if (resolved.state === "not-git")
          return {
            ok: false as const,
            error: { code: "not-found" as const, message: "Not a Git checkout." },
          };
        const provider = resolved.state === "detached" ? "git" : resolved.provider;
        const { files } = await providers[provider].patches(resolved.checkout, source, signal);
        return { ok: true as const, value: { files } };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: hostFailure(error) };
      }
    },

    async oplog({ path }, { signal }) {
      try {
        const resolved = await resolveCheckout(path, "auto", signal);
        if (resolved.state !== "checkout" || resolved.provider !== "gitbutler")
          return { ok: true as const, value: { entries: [] } };
        const payload = await runBut(resolved.checkout.path, ["oplog", "list"], signal);
        return { ok: true as const, value: { entries: parseOplog(payload) } };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: hostFailure(error) };
      }
    },

    async baseHistory({ path, from, limit }, { signal }) {
      try {
        const resolved = await resolveCheckout(path, "git", signal);
        if (resolved.state === "not-git")
          return {
            ok: false as const,
            error: { code: "not-found" as const, message: "Not a Git checkout." },
          };
        const value = await readBaseHistory(resolved.checkout.path, from, limit, signal);
        return { ok: true as const, value };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: hostFailure(error) };
      }
    },

    async range({ path, base, head, read }, { signal }) {
      try {
        const resolved = await resolveCheckout(path, "git", signal);
        if (resolved.state === "not-git")
          return {
            ok: false as const,
            error: { code: "not-found" as const, message: "Not a Git checkout." },
          };
        const cwd = resolved.checkout.path;
        const from = await resolveBase(cwd, base, signal);
        if (!from)
          return {
            ok: false as const,
            error: {
              code: "not-found" as const,
              message: "This checkout has no branch on its remote to compare with.",
            },
          };
        if (read.kind === "files")
          return {
            ok: true as const,
            value: { kind: "files" as const, files: await rangeFiles(cwd, from, head, signal) },
          };
        if (read.kind === "commits")
          return {
            ok: true as const,
            value: {
              kind: "commits" as const,
              commits: await rangeCommits(cwd, from, head, signal),
            },
          };
        const { files } = await rangePatches(cwd, from, head, read.paths, signal);
        return { ok: true as const, value: { kind: "patches" as const, files } };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: hostFailure(error) };
      }
    },

    async checkoutStatus({ path, base }, { signal }) {
      try {
        return { ok: true as const, value: await readCheckoutStatus(path, base, signal) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: hostFailure(error) };
      }
    },

    async checkoutFiles({ path, target }, { signal }) {
      try {
        return { ok: true as const, value: await readCheckoutFiles(path, target, signal) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: hostFailure(error) };
      }
    },

    async checkoutPatches({ path, target, files }, { signal }) {
      try {
        const patches = await readCheckoutPatches(path, target, files, signal);
        return { ok: true as const, value: { patches } };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: hostFailure(error) };
      }
    },

    async renewWatch({ path }, context) {
      if (renew(path)) return { watching: true };
      try {
        const resolved = await resolveCheckout(path, "git", context.signal);
        if (resolved.state === "not-git") return { watching: false };
        await keepWatching(
          {
            name: path,
            real: resolved.checkout.path,
            gitDir: resolved.checkout.gitDir,
            commonDir: resolved.checkout.commonDir,
          },
          context,
        );
        return { watching: true };
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { watching: false };
      }
    },

    async vcsAction({ path, readAs, action, expected }, context) {
      const { signal } = context;
      let resolved;
      try {
        resolved = await resolveCheckout(path, readAs, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: "failed" as const, problem: problemOf(error) };
      }
      if (resolved.state === "not-git")
        return { status: "conflict" as const, detail: "The path is no longer a Git checkout." };
      if (resolved.state === "detached")
        return { status: "conflict" as const, detail: "The checkout has no branch checked out." };
      const { commonDir } = resolved.checkout;
      return oneAtATime(commonDir, async () => {
        // Nothing read before the write is handed out after it.
        forget();
        // Read again inside the queue: a write queued before this one may have moved it.
        const current = await resolveCheckout(path, readAs, signal);
        if (current.state !== "checkout" || current.provider !== resolved.provider)
          return { status: "conflict" as const, detail: "The checkout changed while waiting." };
        const result = await act(current.checkout, current.provider, action, expected, signal);
        forget();
        // A question or a refusal wrote nothing; anything else may have.
        if (result.status !== "confirm" && result.status !== "conflict")
          await changed(commonDir, context, path).catch(() => undefined);
        return result;
      });
    },

    async forgeAccounts(_input, { signal }) {
      try {
        return { ok: true as const, value: { accounts: await readAccounts(execGh, signal) } };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: ghFailure(error) };
      }
    },
    async forgeCall(operation, { signal }) {
      try {
        const { repo, headOwner, branch, account } = operation;
        return {
          ok: true as const,
          value: await readPullRequest(ghFor(account), { repo, headOwner, branch }, signal),
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: ghFailure(error) };
      }
    },
    async forgeReview({ read, account }, { signal }) {
      try {
        return { ok: true as const, value: await runReviewRead(ghFor(account), read, signal) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: ghFailure(error) };
      }
    },
    async forgeSubmitReview({ account, ...write }, { signal }) {
      try {
        return { ok: true as const, value: await submitReviewAt(ghFor(account), write, signal) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: ghFailure(error) };
      }
    },
    async forgeMerge({ account, ...write }, { signal }) {
      try {
        return { ok: true as const, value: await mergeAt(ghFor(account), write, signal) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: ghFailure(error) };
      }
    },
    async forgeWrite({ op: _op, account, ...write }, { signal }) {
      try {
        return { ok: true as const, value: await setDraftAt(ghFor(account), write, signal) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { ok: false as const, error: ghFailure(error) };
      }
    },
  },
  dispose: stopAll,
});
