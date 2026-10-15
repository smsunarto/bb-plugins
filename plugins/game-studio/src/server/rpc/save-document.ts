import { defineMutation } from "@bb-kit/core/rpc";
import { revisionSchema, saveDocumentInput } from "../../shared/schema.ts";
import { saveDocument as runSaveDocument } from "../lib/studio.ts";

export const saveDocument = defineMutation({
  input: saveDocumentInput,
  output: revisionSchema,
  execute(ctx, input) {
    return runSaveDocument(ctx.bb, input);
  },
});
