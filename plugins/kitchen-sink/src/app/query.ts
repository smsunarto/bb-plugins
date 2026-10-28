import { QueryClient } from "@tanstack/react-query";

/**
 * The plugin's one cache. bb remounts panels on navigation, so a client owned
 * by a mount would drop every result each time. One retry keeps a failure
 * visible after seconds instead of the default ladder's half minute. Tests
 * reset it with `queryClient.clear()`.
 */
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
