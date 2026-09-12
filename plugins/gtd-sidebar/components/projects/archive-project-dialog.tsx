import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Initiative } from "@/lib/initiative-types";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * The one place archiving explains itself: the project, its agents, and its
 * subscriptions all pause together. Restore lives on the Projects page.
 */
export function ArchiveProjectDialog({
  initiative,
  agentCount,
  open,
  onOpenChange,
}: {
  initiative: Initiative;
  /** Live descendant count for the copy; subscription count is fetched on open. */
  agentCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const [subscriptionCount, setSubscriptionCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSubscriptionCount(null);
    setError(null);
    setBusy(false);
    rpc
      .call("listSubscriptions", { initiativeId: initiative.id })
      .then((result) => {
        if (cancelled) return;
        setSubscriptionCount(
          result.subscriptions.filter((subscription) => subscription.enabled).length,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, initiative.id, rpc]);

  const archive = () => {
    setBusy(true);
    setError(null);
    rpc
      .call("archiveInitiative", { initiativeId: initiative.id })
      .then(() => onOpenChange(false))
      .catch((archiveError: unknown) =>
        setError(archiveError instanceof Error ? archiveError.message : "Archive failed"),
      )
      .finally(() => setBusy(false));
  };

  const agents = agentCount === 1 ? "1 agent" : `${agentCount} agents`;
  const subscriptions =
    subscriptionCount === null
      ? "its subscriptions"
      : subscriptionCount === 0
        ? "no subscriptions"
        : subscriptionCount === 1
          ? "1 subscription"
          : `${subscriptionCount} subscriptions`;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent aria-label={`Archive ${initiative.name}`}>
        <AlertDialogTitle className="text-sm font-semibold">
          Archive {initiative.name}?
        </AlertDialogTitle>
        <AlertDialogDescription className="mt-1.5 text-xs text-muted-foreground">
          This archives the project and its {agents}, and pauses {subscriptions}. The coordinator
          conversation is kept — restore the project from the Projects page anytime.
        </AlertDialogDescription>
        {error !== null ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <AlertDialogCancel asChild>
            <Button variant="ghost" size="sm" disabled={busy}>
              Cancel
            </Button>
          </AlertDialogCancel>
          {/* A plain controlled Button, not AlertDialogAction: Radix's
              Action closes on click, which would dismiss the dialog before
              the RPC resolves and hide a failure. The dialog closes only on
              success (onOpenChange) or Cancel. */}
          <Button variant="destructive" size="sm" disabled={busy} onClick={archive}>
            {busy ? "Archiving…" : "Archive project"}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
