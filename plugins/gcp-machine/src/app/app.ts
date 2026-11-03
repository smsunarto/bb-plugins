import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { z } from "zod";
import {
  machineIndicatorSchema,
  wakeStateSchema,
  wakeSnapshotSchema,
  type WakeState,
} from "../shared/wake-contract.ts";

import { createWakeIndicator } from "./wake-indicator.ts";

const toastId = "gcp-machine-wake";
const failure = z.object({
  ok: z.literal(false),
  error: z.union([z.string(), z.object({ message: z.string() })]),
});

export default definePluginApp((app) => {
  const indicator = createWakeIndicator();
  app.experimental_icons.register({ name: "gcp-machine/wake", component: indicator.Icon });
  let activate = () => {};
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "wake",
    label: "Wake GCP machine",
    icon: "gcp-machine/wake",
    onActivate: () => activate(),
  });
  app.contentScripts.register({
    id: "wake-feedback",
    mount({ signal }) {
      const online = () => navigator.onLine !== false;
      let pending = false;
      let revision = 0;
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, ms);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
        });
      async function call(method: string, input: unknown): Promise<unknown> {
        const response = await fetch(`/api/v1/plugins/gcp-machine/rpc/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        if (!response.ok)
          throw new Error(
            `BB returned HTTP ${response.status}. Check the connection and try again.`,
          );
        const envelope: unknown = await response.json();
        const error = failure.safeParse(envelope);
        if (error.success)
          throw new Error(
            typeof error.data.error === "string" ? error.data.error : error.data.error.message,
          );
        return z.object({ ok: z.literal(true), result: z.unknown() }).parse(envelope).result;
      }
      function show(state: WakeState) {
        revision++;
        indicator.set(
          !online()
            ? "offline"
            : state.kind === "ready"
              ? "awake"
              : state.kind === "waking" || state.kind === "retrying"
                ? "waking"
                : "offline",
        );
        switch (state.kind) {
          case "idle":
            show({
              kind: "unknown",
              error: "Wake status was reset. Check the machine connection.",
            });
            return;
          case "waking":
            toast.loading("Waking GCP machine…", {
              id: toastId,
              description: `Attempt ${state.attempt} of 3 · waiting for BB to connect`,
              duration: Infinity,
            });
            return;
          case "retrying":
            toast.loading("Retrying GCP wake…", {
              id: toastId,
              description: `Attempt ${state.attempt + 1} of 3 · waiting to retry · ${state.error}`,
              duration: Infinity,
            });
            return;
          case "ready":
            toast.success("GCP machine connected", { id: toastId, duration: 5000 });
            return;
          case "failed":
          case "unknown":
            toast.error(
              state.kind === "unknown"
                ? "GCP wake status is uncertain"
                : "Could not wake GCP machine",
              {
                id: toastId,
                description: state.error,
                duration: Infinity,
                action: { label: "Try again", onClick: () => activate() },
              },
            );
        }
      }
      function disconnected() {
        revision++;
        indicator.set("offline");
      }
      globalThis.addEventListener?.("offline", disconnected);
      // Reads only the enrolled host's BB state; never starts or probes the VM.
      void (async () => {
        while (!signal.aborted) {
          if (!online()) disconnected();
          else if (document.visibilityState !== "hidden") {
            const before = revision;
            try {
              const next = machineIndicatorSchema.parse(await call("getIndicator", null));
              if (!signal.aborted && online() && !pending && revision === before)
                indicator.set(next);
            } catch {
              if (!signal.aborted && !pending && revision === before) indicator.set("offline");
            }
          }
          await pause(5000);
        }
      })();
      activate = () => {
        if (pending || signal.aborted) return;
        pending = true;
        show({ kind: "waking", attempt: 1 });
        void (async () => {
          // A lost response is safe to retry: the server coalesces active jobs.
          const requestId = crypto.randomUUID();
          const requestedAt = Date.now();
          let snapshot;
          for (let attempt = 1; ; attempt++) {
            try {
              snapshot = wakeSnapshotSchema.parse(
                await call("startWake", { requestId, requestedAt }),
              );
              break;
            } catch (cause) {
              if (attempt === 3 || signal.aborted) throw cause;
              await pause(2000 * attempt);
            }
          }
          let state = snapshot.state;
          let failures = 0;
          for (;;) {
            signal.throwIfAborted();
            show(state);
            if (state.kind !== "waking" && state.kind !== "retrying") return;
            await pause(2000);
            while (document.visibilityState === "hidden" || !navigator.onLine) {
              signal.throwIfAborted();
              await pause(5000);
            }
            signal.throwIfAborted();
            try {
              state = wakeStateSchema.parse(await call("getWake", { jobId: snapshot.jobId }));
              failures = 0;
            } catch (cause) {
              if (++failures >= 3 || signal.aborted) throw cause;
              toast.loading("Reconnecting to GCP wake status…", {
                id: toastId,
                duration: Infinity,
              });
              await pause(2000 * failures);
            }
          }
        })()
          .catch((cause: unknown) => {
            if (!signal.aborted)
              show({
                kind: "unknown",
                error: `${cause instanceof Error ? cause.message : String(cause)}. The server may still be waking the machine.`,
              });
          })
          .finally(() => {
            pending = false;
          });
      };
      return () => {
        activate = () => {};
        globalThis.removeEventListener?.("offline", disconnected);
        indicator.set("offline");
        toast.dismiss(toastId);
      };
    },
  });
});
