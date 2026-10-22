import { useMemo, useSyncExternalStore } from "react";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import type { QueryKey } from "@tanstack/react-query";
import { branchReviewRange, prKey } from "../shared/schema.ts";
import type {
  BranchReviewed,
  ChangedFile,
  ChangedFiles,
  BranchReviewRange,
  PullRequest,
  ViewedState,
} from "../shared/schema.ts";
import { useBranchReviewed, withReviewedFiles } from "./branch-review.ts";
import { errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";

/** The Changes view consumes one marks contract, regardless of where marks live. */
export type ReviewMarks = {
  label: "Viewed" | "Reviewed";
  errorKey: string;
  queryKey: QueryKey;
  loadError: Error | null;
  files: (files: readonly ChangedFile[]) => readonly ChangedFile[];
  apply: (path: string, viewed: ViewedState) => void;
  send: (path: string, viewed: boolean) => Promise<{ viewed: ViewedState }>;
};

export function usePrMarks(pr: PullRequest): ReviewMarks {
  const client = rpc.useClient();
  return useMemo(() => {
    const queryKey = rpc.changedFiles.queryKey({ account: pr.account, ref: pr.ref });
    return {
      label: "Viewed",
      errorKey: viewedKey(pr),
      queryKey,
      loadError: null,
      files: (files) => files,
      apply(path, viewed) {
        pluginQueryClient.setQueryData<ChangedFiles>(queryKey, (current) =>
          current
            ? {
                ...current,
                files: current.files.map((file) =>
                  file.path === path ? { ...file, viewed } : file,
                ),
              }
            : current,
        );
      },
      send: (path, viewed) =>
        client.setViewed({ account: pr.account, pullRequestId: pr.id, path, viewed }),
    };
  }, [client, pr]);
}

export function useBranchMarks(
  branch: BranchReviewRange,
  query: ReturnType<typeof useBranchReviewed>,
): ReviewMarks | null {
  const client = rpc.useClient();
  return useMemo(() => {
    if (!query.data) return null;
    const range = branchReviewRange(branch);
    const queryKey = rpc.branchReviewed.queryKey(range);
    const paths = query.data.paths;
    return {
      label: "Reviewed",
      errorKey: `branch:${range.id}:${range.base}:${range.head}`,
      queryKey,
      loadError: query.error,
      files: (files) => withReviewedFiles(files, paths),
      apply(path, state) {
        pluginQueryClient.setQueryData<BranchReviewed>(queryKey, (current) => {
          const reviewed = new Set(current?.paths);
          if (state === "viewed") reviewed.add(path);
          else reviewed.delete(path);
          return { paths: [...reviewed] };
        });
      },
      send: (path, viewed) => client.setBranchViewed({ ...range, path, viewed }),
    };
  }, [client, branch, query.data, query.error]);
}

/**
 * One file's Viewed writes: its newest click, so an older answer never lands
 * over it, and its last queued write, which the next one waits for. Kept here,
 * not in the tab, so a click after leaving the tab and coming back still waits
 * for the one before. Keyed by {@link viewedKey} and path, and dropped once
 * the last write settles.
 */
type ViewedQueue = { latest: symbol; tail: Promise<void> };
const viewedQueues = new Map<string, ViewedQueue>();

/**
 * Viewed marks are GitHub's per user, so one pull request read as two
 * accounts keeps two sets of them, each with its own writes and errors.
 */
function viewedKey(pr: Pick<PullRequest, "account" | "ref">): string {
  return `${pr.account.toLowerCase()}:${prKey(pr.ref)}`;
}

/**
 * Each pull request's Viewed failures as one account, by path. Kept here
 * with the queues, not in the tab, so a write that fails after the tab was
 * left and opened again still says why its box went back. A path's error
 * goes once a write for it succeeds, and the entry once its last error goes.
 */
const viewedErrors = new Map<string, ReadonlyMap<string, string>>();
const viewedErrorListeners = new Set<() => void>();

/** Sets one file's Viewed error, or clears it with null. */
function setViewedError(pull: string, path: string, error: string | null): void {
  const errors = new Map(viewedErrors.get(pull));
  if (error !== null) errors.set(path, error);
  else if (!errors.delete(path)) return;
  if (errors.size > 0) viewedErrors.set(pull, errors);
  else viewedErrors.delete(pull);
  for (const listener of viewedErrorListeners) listener();
}

export function dismissViewedErrors(pull: string): void {
  if (!viewedErrors.delete(pull)) return;
  for (const listener of viewedErrorListeners) listener();
}

function subscribeViewedErrors(listener: () => void): () => void {
  viewedErrorListeners.add(listener);
  return () => viewedErrorListeners.delete(listener);
}

export function useViewedErrors(pull: string): ReadonlyMap<string, string> | undefined {
  return useSyncExternalStore(subscribeViewedErrors, () => viewedErrors.get(pull));
}

/** Optimistic marks, folding, rollback and a serialized write queue per target/file. */
export function useViewedToggle(
  marks: ReviewMarks | null,
  setOpen: (path: string, open: boolean) => void,
) {
  return useMemo(() => {
    if (!marks) return null;
    return (file: ChangedFile, viewed: boolean) => {
      const { queryKey, errorKey } = marks;
      const key = `${errorKey}:${file.path}`;
      const click = Symbol(file.path);
      const latest = () => viewedQueues.get(key)?.latest === click;
      void pluginQueryClient.cancelQueries({ queryKey });
      marks.apply(file.path, viewed ? "viewed" : "unviewed");
      setOpen(file.path, !viewed);
      const send = async () => {
        if (!latest()) return;
        try {
          const result = await marks.send(file.path, viewed);
          setViewedError(errorKey, file.path, null);
          if (latest()) marks.apply(file.path, result.viewed);
        } catch (error) {
          if (!latest()) return;
          marks.apply(file.path, file.viewed);
          setOpen(file.path, viewed);
          setViewedError(
            errorKey,
            file.path,
            `Could not mark ${file.path} as ${viewed ? "" : "not "}${marks.label.toLowerCase()}. ${errorText(error)}`,
          );
          void pluginQueryClient.invalidateQueries({ queryKey });
        }
      };
      const queued: ViewedQueue = {
        latest: click,
        tail: (viewedQueues.get(key)?.tail ?? Promise.resolve()).then(send),
      };
      viewedQueues.set(key, queued);
      void queued.tail.finally(() => {
        if (viewedQueues.get(key) === queued) viewedQueues.delete(key);
      });
    };
  }, [marks, setOpen]);
}
