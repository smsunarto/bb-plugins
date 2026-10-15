import { defineTool, type ToolContext } from "@bb-kit/core/tools";
import { slotActionSchema } from "../../shared/slot-contract.ts";
import { slotAction, type SlotsContext } from "../lib/slot-action.ts";

export const slots = defineTool({
  parameters: slotActionSchema,
  async execute(ctx: ToolContext<SlotsContext>, input) {
    return JSON.stringify(
      await slotAction(ctx, input, ctx.tool.threadId ?? undefined, ctx.tool.signal),
    );
  },
});
