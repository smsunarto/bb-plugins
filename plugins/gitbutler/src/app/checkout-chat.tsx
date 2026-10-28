import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { CheckoutSelection } from "../shared/schema.ts";
import type { WorkspaceTarget } from "./branch-actions.tsx";
import { Button } from "./components/ui/button.tsx";
import { errorText } from "./notice.tsx";
import { useRpcQuery } from "./rpc.ts";
import { cn } from "./lib/utils.ts";

type Props = {
  target: WorkspaceTarget & { checkout: CheckoutSelection };
  environmentId: string | null;
  children?: ReactNode;
};

/** Changing the board cancels a pending navigation to its previous checkout. */
export function CheckoutChatActions(props: Props) {
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

function CheckoutChatControl({ target, environmentId, children }: Props) {
  const navigate = useBbNavigate();
  const descriptionId = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [opening, setOpening] = useState(false);
  // Read on click only. Each read walks the machine's environments and
  // threads, and its answer can change any time before the click anyway.
  const query = useRpcQuery(
    "checkoutChatTarget",
    { ...target, ...(environmentId ? { environmentId } : {}) },
    { enabled: false, retry: false },
  );
  const reason = query.error
    ? errorText(query.error)
    : query.data?.state === "unavailable"
      ? query.data.reason
      : null;
  // An unavailable answer stays clickable: the click is what checks again.
  const disabled = !environmentId || opening;
  const progress = opening ? "Opening…" : null;
  const busy = progress !== null;

  const open = async () => {
    if (disabled) return;
    setOpening(true);
    try {
      // Errors stay on the query, so the next click's answer replaces them.
      const result = await query.refetch({ throwOnError: true }).catch(() => null);
      if (!mounted.current || result?.data?.state !== "ready") return;
      navigate.toCompose({
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
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1 gap-y-2">
      {children}
      <span
        className="shrink-0"
        title={reason ?? `Start a new agent chat in ${target.checkout.path}`}
      >
        <Button
          size="sm"
          className="h-7 min-w-24 gap-1.5 px-2.5 text-xs"
          aria-label={`New agent chat in ${target.checkout.path}`}
          aria-describedby={descriptionId}
          aria-busy={busy}
          disabled={disabled}
          onClick={() => void open()}
        >
          <Icon
            name={busy ? "Spinner" : "MessageSquarePlus"}
            className={cn("size-3.5", busy && "animate-spin motion-reduce:animate-none")}
            aria-hidden
          />
          {progress ?? "New chat"}
        </Button>
      </span>
      <ChatStatus
        id={descriptionId}
        reason={reason}
        progress={progress}
        error={Boolean(query.error)}
      />
    </div>
  );
}

function ChatStatus({
  id,
  reason,
  progress,
  error,
}: {
  id: string;
  reason: string | null;
  progress: string | null;
  error: boolean;
}) {
  return (
    <span
      id={id}
      role={error ? "alert" : "status"}
      title={reason ?? undefined}
      className={
        reason
          ? "inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground"
          : "sr-only"
      }
    >
      <Icon name="Info" className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">{reason ?? progress}</span>
    </span>
  );
}
