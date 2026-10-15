import { defineMutation } from "@bb-kit/core/rpc";
import { assetSchema, uploadAssetInput } from "../../shared/schema.ts";
import { uploadAsset as runUploadAsset } from "../lib/studio.ts";

export const uploadAsset = defineMutation({
  input: uploadAssetInput,
  output: assetSchema,
  execute(ctx, input) {
    return runUploadAsset(ctx.bb, input);
  },
});
