import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import type { Context } from "@bb-kit/core/plugin";
import { z } from "zod";
import { readAgentPolicy } from "../lib/autorouter/agent-policy.ts";

export const autorouterPolicy = defineTool({
  description:
    "Read the current autorouter rules and enabled subthread models. Includes live Fable/Opus usage eligibility. Read this before deciding whether to delegate a task or review to a BB subthread.",
  parameters: z.strictObject({}),
  async execute({ bb, tool }: ToolContext<Context>) {
    return JSON.stringify(await readAgentPolicy(bb, tool.threadId));
  },
});
