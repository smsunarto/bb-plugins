import { QueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * The plugin's one cache. bb remounts panels on navigation, so a client
 * owned by a mount would drop every result each time. This one lives as
 * long as the plugin's app bundle. One retry keeps a failure visible
 * after seconds instead of the default ladder's half minute. Tests
 * reset it with `queryClient.clear()`.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

// Confirmation belongs to a query, outside persisted/optimistic data. Errors
// revoke it until a real fetch succeeds, even if a manual write clears the error.
// Weak keys release both the query and its response when the cache evicts them.
const networkData = new WeakMap<object, unknown>();
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated") return;
  if (event.action.type === "error") networkData.delete(event.query);
  if (event.action.type === "success" && !event.action.manual)
    networkData.set(event.query, event.query.state.data);
});

export function hasNetworkData(key: QueryKey): boolean {
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  return (
    query !== undefined && networkData.has(query) && networkData.get(query) === query.state.data
  );
}
