import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineTool, type ToolContext } from "./tools.ts";
import type { Context } from "../context.ts";

test("defineTool returns the definition by identity", () => {
  const definition = {
    description: "Echo",
    parameters: z.object({ text: z.string() }),
    execute: (_ctx: ToolContext<Context>, { text }: { text: string }) => text,
  };
  assert.equal(defineTool(definition), definition);
});
