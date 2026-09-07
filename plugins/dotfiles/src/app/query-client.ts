import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";

// refetchOnWindowFocus stays on: it is the free pickup of external git
// edits in place of a watcher, which v1 does not add.
export const dotfilesQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

// The only QueryClient in the plugin: every registered component wraps
// itself in this boundary so all mounts share one cache.
export function DotfilesBoundary(props: { readonly children: ReactNode }): ReactElement {
  return createElement(PluginQueryBoundary, { client: dotfilesQueryClient }, props.children);
}
