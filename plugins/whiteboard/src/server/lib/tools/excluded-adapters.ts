/**
 * Specs only. Upstream's stdio MCP server (`mcp.ts`) is excluded: bb registers
 * the tools itself (design §3.5). The vendored `instructions.test.ts` imports
 * it for tests that are skipped in the port, so a vendor redirect points that
 * import here.
 */

function excluded(name: string): never {
  throw new Error(`whiteboard: ${name} is excluded in bb; bb registers the agent tools`);
}

export async function serveReviewMcp(
  ..._args: readonly unknown[]
): Promise<{ close(): Promise<void> }> {
  return excluded("serveReviewMcp");
}
