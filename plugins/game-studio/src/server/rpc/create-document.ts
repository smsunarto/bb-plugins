import { defineMutation } from "@bb-kit/core/rpc";
import { createDocumentInput, workspaceSchema } from "../../shared/schema.ts";
import { createDocument as runCreateDocument } from "../lib/studio.ts";

export const createDocument = defineMutation({
  input: createDocumentInput,
  output: workspaceSchema,
  execute(ctx, input) {
    return runCreateDocument(ctx.bb, input);
  },
});
