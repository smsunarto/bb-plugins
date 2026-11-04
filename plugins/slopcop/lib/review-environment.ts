import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { PullRequest } from "./types";

const selectionSchema = z.object({
  type: z.enum(["project-default", "reuse", "host", "provider"]),
  hostId: z.string().optional(),
  environmentId: z.string().optional(),
  machine: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("existing"), hostId: z.string() }),
      z.object({
        type: z.literal("new"),
        machineProviderId: z.string(),
        inputs: z.json().nullable().default({}),
      }),
    ])
    .optional(),
});

type SpawnEnvironment = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"];

export async function reviewWorktree(
  bb: BbPluginApi,
  selection: unknown,
  target: Pick<PullRequest, "headRefName" | "headRefOid" | "isCrossRepository">,
): Promise<SpawnEnvironment> {
  const configured = selectionSchema.parse(selection ?? { type: "project-default" });
  const branch = {
    kind: "named" as const,
    name:
      target.isCrossRepository || !target.headRefName
        ? target.headRefOid
        : `origin/${target.headRefName}`,
  };
  if (configured.type === "provider") {
    return {
      type: "provider",
      environmentProviderId: "git-worktree",
      inputs: { branch },
      ...(configured.machine === undefined ? {} : { machine: configured.machine }),
    };
  }
  let hostId = configured.hostId;
  if (configured.type === "reuse") {
    if (!configured.environmentId) throw new Error("review environment is missing its ID");
    hostId = (await bb.sdk.environments.get({ environmentId: configured.environmentId })).hostId;
  }
  return {
    type: "host",
    ...(hostId === undefined ? {} : { hostId }),
    workspace: {
      type: "managed-worktree",
      baseBranch: branch,
    },
  };
}
