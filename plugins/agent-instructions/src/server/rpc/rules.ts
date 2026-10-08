import { defineQuery } from "@bb-kit/core/rpc";
import type { Context } from "@bb-kit/core/plugin";
import { rulesStateSchema } from "../../shared/rules.ts";
import type { RuleStore } from "../lib/store.ts";

export const rules = defineQuery({
  output: rulesStateSchema,
  description: "List the instruction rules in order, with the revision they are at",
  execute: (ctx: Context<{ store: RuleStore }>) => ctx.store.state(),
});
