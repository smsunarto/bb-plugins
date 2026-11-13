import {
  PluginCliError,
  type BbPluginApi,
  type ExperimentalHostClient,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { hostContract } from "../shared/host-contract.ts";

export interface ServerContext {
  bb: BbPluginApi;
  host: ExperimentalHostClient<typeof hostContract>;
  sudoCacheMinutes(): Promise<number>;
}

export function cliError(message: string, code: string, hint?: string): never {
  throw new PluginCliError(message, { code, ...(hint === undefined ? {} : { hint }) });
}

export function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const threadHostSchema = z.object({
  host: z.object({ id: z.string(), name: z.string().nullable().optional() }).nullable().optional(),
});

export interface ThreadTarget {
  threadId: string;
  cwd: string;
  hostId: string;
  hostName: string;
  signal: AbortSignal | undefined;
}

/** The invoking thread, its working directory, and its live host. */
export async function threadTarget(
  bb: BbPluginApi,
  command: string,
  context: PluginCliContext,
): Promise<ThreadTarget> {
  if (!context.threadId)
    cliError(`bb secret ${command} must run from a bb thread.`, "missing_thread");
  if (!context.cwd) {
    cliError(`bb secret ${command} requires the invoking working directory.`, "missing_cwd");
  }
  const { host } = threadHostSchema.parse(
    await bb.sdk.threads.get({ threadId: context.threadId, include: "host" }),
  );
  if (!host?.id) cliError("The thread needs a live host.", "missing_host");
  return {
    threadId: context.threadId,
    cwd: context.cwd,
    hostId: host.id,
    hostName: host.name || host.id,
    signal: context.signal,
  };
}
