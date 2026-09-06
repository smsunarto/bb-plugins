import { createRPC } from "@bb-kit/core/rpc/query";
import type plugin from "../server/server.ts";

export const rpc = createRPC<(typeof plugin)["rpc"]>();

export function definedFields<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
