/**
 * Specs only. Upstream's stdio MCP server (`mcp.ts`) and `whiteboard api` CLI
 * (`agent-cli.ts`) are excluded: bb registers the tools itself (design §3.5).
 * The vendored `instructions.test.ts` imports both for tests that are skipped
 * in the port, so a vendor redirect points those imports here.
 */

function excluded(name: string): never {
  throw new Error(`whiteboard: ${name} is excluded in bb; bb registers the agent tools`);
}

export async function serveReviewMcp(
  ..._args: readonly unknown[]
): Promise<{ close(): Promise<void> }> {
  return excluded("serveReviewMcp");
}

export async function runReviewAgentCli(..._args: readonly unknown[]): Promise<number> {
  return excluded("runReviewAgentCli");
}
