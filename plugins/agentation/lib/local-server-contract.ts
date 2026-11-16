/**
 * The server ↔ host contract for the shared Agentation server: one idempotent
 * call that starts, keeps, or stops `agentation-mcp server` on a machine.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The port the Agentation toolbar and the stdio `agentation` MCP entry expect. */
export const LOCAL_SERVER_PORT = 4747;

export const localServerStateSchema = z.object({
  /**
   * running: this plugin's server answers on the port.
   * external: something else already answers on the port; the host checks back.
   * missing: no `agentation-mcp` on the daemon's PATH.
   * stopped: the setting is off and nothing of ours runs.
   * failed: the server exited at start or kept crashing.
   */
  state: z.enum(["running", "external", "missing", "stopped", "failed"]),
  pid: z.number().int().nullable(),
  message: z.string().nullable(),
});

export type LocalServerState = z.infer<typeof localServerStateSchema>;

export const agentationHostContract = defineRpcContract({
  ensureLocalServer: {
    input: z.object({ enabled: z.boolean() }),
    output: localServerStateSchema,
  },
});
