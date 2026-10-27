import { useMemo } from "react";
import { experimental_useRpcQuery as useRpcQuery } from "@get-bb/plugin-sdk/app";
import { gtdSidebarRpcContract } from "../lib/rpc-contract";

const NAMING_READ = {};

/** Threads whose title the backend is generating, refreshed as naming starts and ends. */
export function useNamingThreads(): ReadonlySet<string> {
  const { data } = useRpcQuery({
    contract: gtdSidebarRpcContract,
    method: "listNamingThreads",
    input: NAMING_READ,
  });
  return useMemo(() => new Set(data), [data]);
}
