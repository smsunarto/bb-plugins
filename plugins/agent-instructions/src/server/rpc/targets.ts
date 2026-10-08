import { defineQuery } from "@bb-kit/core/rpc";
import { targetsSchema } from "../../shared/targets.ts";
import { loadTargets } from "../lib/targets.ts";

export const targets = defineQuery({
  output: targetsSchema,
  description: "List the hosts, providers, and projects a rule can be scoped to",
  execute: (ctx) => loadTargets(ctx.bb),
});
