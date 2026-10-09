import type { Context } from "@bb-kit/core/plugin";
import type { Gh } from "./gh.ts";
import type { Store } from "./store.ts";

/** What `services` adds to every handler's ctx. */
export type CodeReviewContext = Context<{ gh: Gh; store: Store }>;
