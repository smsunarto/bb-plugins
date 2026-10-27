import type { Context } from "@bb-kit/core/plugin";
import type { BlobReader } from "./blobs.ts";
import type { GitHub } from "./gh.ts";
import type { Store } from "./store.ts";
import type { UnityPreviews } from "./unity-preview.ts";

/** What `services` adds to every handler's ctx. */
export type CodeReviewContext = Context<{
  github: GitHub;
  store: Store;
  blobs: BlobReader;
  unity: UnityPreviews;
}>;
