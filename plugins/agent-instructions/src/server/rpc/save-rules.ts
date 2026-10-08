import { defineMutation } from "@bb-kit/core/rpc";
import type { Context } from "@bb-kit/core/plugin";
import { z } from "zod";
import { rulesSchema, saveResultSchema } from "../../shared/rules.ts";
import type { RuleStore } from "../lib/store.ts";

export const saveRules = defineMutation({
  input: z.object({ rules: rulesSchema, revision: z.number().int().nonnegative() }),
  output: saveResultSchema,
  description: "Replace every instruction rule, unless they changed since `revision`",
  execute: (ctx: Context<{ store: RuleStore }>, input) =>
    ctx.store.save(input.rules, input.revision),
});
