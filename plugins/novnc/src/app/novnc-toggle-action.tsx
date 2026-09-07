import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useComposerView } from "@get-bb/plugin-sdk/app";
import { NovncPip, type PipMode } from "./novnc-pip.tsx";
import { rpc, type RPCOutput } from "./rpc.ts";

type NovncStatus = RPCOutput<"getNovncStatus">;

const RECHECK_INTERVAL_MS = 30_000;

export function NovncToggleAction() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const client = rpc.useClient();
  const [status, setStatus] = useState<NovncStatus | null>(null);
  const [mode, setMode] = useState<PipMode>("hidden");
  // Bumped on every check and on cleanup so a stale in-flight response
  // can never overwrite the state of a newer thread.
  const sequence = useRef(0);

  useEffect(() => {
    setStatus(null);
    setMode("hidden");
    if (threadId === null) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const ticket = ++sequence.current;
      let result: NovncStatus | null = null;
      try {
        result = await client.getNovncStatus({ threadId });
      } catch {
        result = null;
      }
      if (ticket !== sequence.current) {
        return;
      }
      setStatus(result);
      if (result === null || result.state !== "ready") {
        timer = setTimeout(() => {
          void check();
        }, RECHECK_INTERVAL_MS);
      }
    };
    void check();
    return () => {
      sequence.current += 1;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [client, threadId]);

  if (status === null || status.state !== "ready") {
    return null;
  }
  const shown = mode !== "hidden";
  return (
    <>
      <button
        aria-label={shown ? "Hide remote screen" : "Show remote screen"}
        aria-pressed={shown}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-pressed:text-foreground"
        onClick={() => setMode(shown ? "hidden" : "pip")}
        title={shown ? "Hide remote screen" : "Show remote screen"}
        type="button"
      >
        <svg
          aria-hidden="true"
          fill="none"
          height="16"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="16"
        >
          <rect height="14" rx="2" width="20" x="2" y="3" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      </button>
      {mode !== "hidden"
        ? createPortal(
            <NovncPip
              mode={mode}
              onExpand={() => setMode("expanded")}
              onMinimize={() => setMode("pip")}
              url={status.url}
            />,
            document.body,
          )
        : null}
    </>
  );
}
