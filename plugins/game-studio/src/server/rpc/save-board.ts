import { defineMutation } from "@bb-kit/core/rpc";
import { revisionSchema, saveBoardInput } from "../../shared/schema.ts";
import { saveBoard as runSaveBoard } from "../lib/studio.ts";

export const saveBoard = defineMutation({
  input: saveBoardInput,
  output: revisionSchema,
  execute(ctx, input) {
    return runSaveBoard(ctx.bb, input);
  },
});
