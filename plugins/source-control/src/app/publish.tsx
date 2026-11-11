/**
 * Create PR on the thread's own branch when GitHub has none for it: a child
 * thread writes the description and opens it, as gitbutler's Create PR did
 * (`plugins/gitbutler/src/app/branch-actions.tsx`). The tab finds that child
 * again after a remount, and watches it until it stops.
 */
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { sourceControlContract } from "../contract/rpc.ts";
import { Button, Pending } from "./ui.tsx";

/** While a child works, the tab looks this often to see it finish. */
const PUBLISH_POLL_MS = 5_000;

export function CreatePullRequest({
  threadId,
  branch,
  head,
  busy,
}: {
  threadId: string;
  branch: string;
  /** The head the reader sees: the child starts only while the branch is still there. */
  head: string;
  busy: boolean;
}) {
  const navigate = useBbNavigate();
  const requests = useRpcQuery({
    contract: sourceControlContract,
    method: "publishRequests",
    input: { threadId },
  });
  const mutation = useRpcMutation({ contract: sourceControlContract, method: "createPullRequest" });
  const [error, setError] = useState<string | null>(null);
  const current = requests.data?.requests.find((request) => request.branch === branch);
  const running = current?.running ?? false;
  const { refetch } = requests;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => void refetch(), PUBLISH_POLL_MS);
    return () => clearInterval(timer);
  }, [running, refetch]);
  const start = async () => {
    setError(null);
    try {
      const answer = await mutation.mutate({ threadId, branch, head });
      if (!answer.ok) setError(answer.message);
      await refetch();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't start the PR thread.");
    }
  };
  return (
    <>
      {running ? null : (
        <Button
          disabled={busy || mutation.isPending}
          aria-label={`Create PR for ${branch}`}
          data-testid="sc-create-pr"
          onClick={() => void start()}
        >
          <Pending pending={mutation.isPending} icon="GitPullRequest" />
          Create PR
        </Button>
      )}
      {current ? (
        // `output` is the native polite live region, so the hand-off is announced.
        <output
          data-testid="sc-create-pr-status"
          className="flex min-w-0 basis-full items-center gap-1.5 text-[12px] leading-4 text-muted-foreground"
        >
          <span className="me-auto min-w-0">
            {current.running
              ? "A subthread is writing and opening the PR."
              : "The PR subthread stopped without opening a PR."}
          </span>
          <Button variant="ghost" onClick={() => navigate.toThread(current.threadId)}>
            Open subthread
          </Button>
        </output>
      ) : null}
      {error ? (
        <span role="alert" className="basis-full text-[12px] leading-4 text-warning">
          {error}
        </span>
      ) : null}
    </>
  );
}
