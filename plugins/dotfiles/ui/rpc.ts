import { createRPC } from "@bb-kit/core/query";
import type { RPC } from "../server.ts";

/** The namespace, written ONCE in ui/ (§5) — import `rpc` everywhere. */
export const rpc = createRPC<RPC>("dotfiles");
