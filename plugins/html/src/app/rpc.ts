import { useRpc } from "@get-bb/plugin-sdk/app";
import type { contract } from "../server/server.ts";

/** The typed client for this plugin's RPC methods, resolved per render. */
export function useHtmlRpc() {
  return useRpc<typeof contract>();
}
