import { useEffect, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_useSidebarThreadActions as useThreadActions,
} from "@get-bb/plugin-sdk/app";
import type { CheckoutSelection } from "../shared/schema.ts";
import type { WorkspaceTarget } from "./branch-actions.tsx";
import { Button } from "./components/ui/button.tsx";
import { errorText } from "./notice.tsx";
import { rpc } from "./rpc.ts";

type Props = {
  target: WorkspaceTarget & { checkout: CheckoutSelection };
  environmentId: string | null;
};

/** Changing the board cancels a pending navigation to its previous checkout. */
export function CheckoutChatButton(props: Props) {
  const { target, environmentId } = props;
  const scope = JSON.stringify([
    target.threadId,
    target.repositoryKey ?? null,
    environmentId,
    target.checkout.hostId,
    target.checkout.path,
  ]);
  return <CheckoutChatControl key={scope} {...props} />;
}

function CheckoutChatControl({ target, environmentId }: Props) {
  const threads = useThreadActions();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [opening, setOpening] = useState(false);
  const query = rpc.checkoutChatTarget.useQuery(
    { ...target, ...(environmentId ? { environmentId } : {}) },
    { enabled: Boolean(environmentId), staleTime: 10_000, refetchInterval: 30_000, retry: false },
  );
  const reason = query.error
    ? errorText(query.error)
    : query.data?.state === "unavailable"
      ? query.data.reason
      : null;
  const disabled =
    !environmentId || query.isPending || opening || query.data?.state === "unavailable";

  const open = async () => {
    if (disabled) return;
    setOpening(true);
    try {
      // A displayed environment can have been archived or moved since the card loaded.
      // Errors stay on the query so later background results can replace them.
      const result = await query.refetch({ throwOnError: true }).catch(() => null);
      if (!mounted.current || result?.data?.state !== "ready") return;
      threads.openNewThread({
        projectId: result.data.projectId,
        environmentId: result.data.environmentId,
        hostId: result.data.hostId,
        focusPrompt: true,
      });
    } finally {
      if (mounted.current) setOpening(false);
    }
  };

  return (
    <span
      className="inline-flex max-w-full min-w-0 flex-col items-end gap-1"
      title={reason ?? `Start a new agent chat in ${target.checkout.path}`}
    >
      <Button
        variant="outline"
        size="sm"
        className="h-6 shrink-0 gap-1 px-2 text-xs font-normal"
        aria-label={`New agent chat in ${target.checkout.path}`}
        aria-busy={query.isPending || opening}
        disabled={disabled}
        onClick={() => void open()}
      >
        <Icon name="MessageSquarePlus" className="size-3" aria-hidden />
        {opening ? "Opening…" : "New chat"}
      </Button>
      {reason ? (
        <span
          role={query.error ? "alert" : "status"}
          className="max-w-64 text-right text-[11px] break-words text-muted-foreground"
        >
          {reason}
        </span>
      ) : null}
    </span>
  );
}
