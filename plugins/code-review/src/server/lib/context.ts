import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BlobReader } from "./blobs.ts";
import type { GitHub } from "./gh.ts";
import type { PrWatcher } from "./pr-watch.ts";
import type { Store } from "./store.ts";
import type { UnityPreviews } from "./unity-preview.ts";

/** The plugin's long-lived collaborators, built once per load. */
export type CodeReviewServices = {
  github: GitHub;
  store: Store;
  blobs: BlobReader;
  unity: UnityPreviews;
  watcher: PrWatcher;
};

/** What every RPC handler, command, and tool receives: the host plus the services. */
export type CodeReviewContext = Readonly<{ bb: BbPluginApi } & CodeReviewServices>;
