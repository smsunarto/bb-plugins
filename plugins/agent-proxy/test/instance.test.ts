import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentProxyInstance } from "../lib/instance.ts";

const homeDir = "/Users/scott";

test("keeps production on the canonical port and service labels", () => {
  assert.deepEqual(resolveAgentProxyInstance("/Users/scott/.bb", { homeDir }), {
    kind: "production",
    defaultPort: 8317,
    coreLabel: "com.bb.plugin.agent-proxy",
    tunnelLabel: "com.bb.plugin.agent-proxy.cloudflare-tunnel",
  });

  assert.deepEqual(resolveAgentProxyInstance("/tmp/custom-bb-data", { homeDir }), {
    kind: "production",
    defaultPort: 8317,
    coreLabel: "com.bb.plugin.agent-proxy",
    tunnelLabel: "com.bb.plugin.agent-proxy.cloudflare-tunnel",
  });
});

test("derives stable development ports and labels from the BB checkout hash", () => {
  assert.deepEqual(
    resolveAgentProxyInstance("/Users/scott/.bb-dev/bb-worktrees-dev-bb-5468d9357fa9", { homeDir }),
    {
      kind: "development",
      defaultPort: 56_493,
      coreLabel: "com.bb.plugin.agent-proxy.dev.5468d9357fa9",
      tunnelLabel: "com.bb.plugin.agent-proxy.dev.5468d9357fa9.cloudflare-tunnel",
    },
  );

  assert.deepEqual(
    resolveAgentProxyInstance("/Users/scott/.bb-dev/worktree-abcdef123456", { homeDir }),
    {
      kind: "development",
      defaultPort: 51_018,
      coreLabel: "com.bb.plugin.agent-proxy.dev.abcdef123456",
      tunnelLabel: "com.bb.plugin.agent-proxy.dev.abcdef123456.cloudflare-tunnel",
    },
  );
});

test("fails closed for malformed data directories inside the BB development root", () => {
  assert.throws(
    () => resolveAgentProxyInstance("/Users/scott/.bb-dev/not-a-checkout", { homeDir }),
    /valid direct BB development instance/,
  );
  assert.throws(
    () =>
      resolveAgentProxyInstance("/Users/scott/.bb-dev/bb-worktrees-dev-bb-5468d9357fa9/nested", {
        homeDir,
      }),
    /valid direct BB development instance/,
  );
  assert.throws(
    () => resolveAgentProxyInstance("/Users/scott/.bb-dev", { homeDir }),
    /valid direct BB development instance/,
  );
});
