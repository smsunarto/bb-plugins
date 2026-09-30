import { createRPC } from "@bb-kit/core/rpc/query";
import type plugin from "../server/server.ts";

export const rpc = createRPC<(typeof plugin)["rpc"]>();
