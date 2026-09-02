import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";

export const canvasQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

export function CanvasBoundary(props: { readonly children: ReactNode }): ReactElement {
  return createElement(PluginQueryBoundary, { client: canvasQueryClient }, props.children);
}
