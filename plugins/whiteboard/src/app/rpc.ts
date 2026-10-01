import type { Client } from "@bb-kit/core/rpc";
import { createRPC } from "@bb-kit/core/rpc/query";
import type plugin from "../server/server.ts";

type Procedures = (typeof plugin)["rpc"];

export const rpc = createRPC<Procedures>();

/** The imperative client `rpc.useClient()` returns; the bridge holds one per mount. */
export type WhiteboardRpcClient = Client<Procedures>;
