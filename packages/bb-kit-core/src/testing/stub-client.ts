/**
 * Build a full client from only the RPCs a test stubs. Stubbed
 * keys pass through. Any other RPC reads as a function that
 * throws, naming the RPC, when CALLED. `then` and symbol keys
 * read as undefined so the client never becomes a thenable.
 */
export function stubClient<C extends object>(partial: Partial<C>): C {
  return new Proxy(partial, {
    get(target, property) {
      if (typeof property !== "string" || property === "then") {
        return undefined;
      }
      if (property in target) {
        return (target as Record<string, unknown>)[property];
      }
      return () => {
        throw new Error(`stubClient: RPC "${property}" was called without a stub`);
      };
    },
  }) as unknown as C;
}
