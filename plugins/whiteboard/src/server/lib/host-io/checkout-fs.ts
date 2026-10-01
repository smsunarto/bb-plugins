import type * as upstream from "../../../shared/node/vendor/review/src/review-api/checkout-fs.ts";
import { lstat, readFile, readlink, realpath, stat } from "./fs.ts";

/**
 * Server facade for `review-api/checkout-fs` (design §3.1): the
 * `node:fs/promises` surface the engine uses on checkout paths, run on the
 * checkout's host. Only the calls the engine makes are carried; any other
 * member throws, so a new upstream use fails loudly instead of reading the
 * server's disk.
 */
const carried: Record<string, unknown> = { lstat, readFile, readlink, realpath, stat };

export const checkoutFs: typeof upstream.checkoutFs = new Proxy({} as typeof upstream.checkoutFs, {
  get(_target, property) {
    if (typeof property !== "string" || property === "then") return undefined;
    if (Object.hasOwn(carried, property)) return carried[property];
    throw new Error(`whiteboard: checkoutFs.${String(property)} is not carried to the host.`);
  },
});
