import { z } from "zod";
import { defineQuery } from "@bb-kit/core/rpc";
import { canvasContextInput } from "../../shared/canvas-agent.ts";
import { readCanvasContext } from "../lib/canvas-context.ts";

/** The same bounded read for CLI agents, with the read-only access of get. */
export const canvasContext = defineQuery({
  input: canvasContextInput,
  output: z.record(z.string(), z.json()),
  async execute(ctx, input) {
    return z
      .record(z.string(), z.json())
      .parse(JSON.parse(JSON.stringify(await readCanvasContext(ctx.bb, input))));
  },
});
