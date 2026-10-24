import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it } from "bun:test";

if (process.env.GTD_PULL_REQUEST_TEST_CHILD !== "1") {
  it("useRowPullRequest passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_PULL_REQUEST_TEST_CHILD: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
    JSDOM: new (
      html: string,
      options: { url: string },
    ) => {
      window: Window & typeof globalThis;
    };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (name in globalThis) continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: Reflect.get(dom.window, name),
      writable: true,
    });
  }
  const { cleanup, waitFor } = await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();
  const { createElement } = await import("react");
  const { useRowPullRequest } = await import("../hooks/use-row-pull-request.ts");

  function PullRequestRow({ environmentId }: { environmentId: string | null }) {
    const pullRequest = useRowPullRequest(environmentId);
    return createElement(
      "span",
      { "data-row": environmentId ?? "none" },
      pullRequest === null ? "none" : `#${pullRequest.number} ${pullRequest.state}`,
    );
  }

  function PullRequestProbe({ environmentIds }: { environmentIds: readonly (string | null)[] }) {
    return environmentIds.map((environmentId) =>
      createElement(PullRequestRow, { key: environmentId ?? "none", environmentId }),
    );
  }

  const pullRequest = {
    number: 12,
    title: "Row rendering",
    url: "https://github.com/acme/app/pull/12",
    state: "open",
    attention: "checks_failed",
    // Fields the card does not draw still arrive, and are ignored.
    checks: { state: "failure" },
  };

  function rowText(slot: { container: HTMLElement }, row: string) {
    return slot.container.querySelector(`[data-row="${row}"]`)?.textContent;
  }

  afterEach(() => cleanup());
  afterAll(() => dom.window.close());

  describe("useRowPullRequest", () => {
    it("reads GitHub PR Status by environment and shows only available rows", async () => {
      const slot = renderSlot(
        { component: PullRequestProbe },
        { environmentIds: ["env-open", "env-absent", "env-offline", null] },
        {
          rpc: {
            pullRequests: (input: unknown) =>
              Object.fromEntries(
                (input as { keys: string[] }).keys.map((key) => [
                  key,
                  key === "env-open"
                    ? { outcome: "available", pullRequest }
                    : key === "env-offline"
                      ? { outcome: "unavailable", message: "Studio is offline" }
                      : { outcome: "absent" },
                ]),
              ),
          },
        },
      );
      await waitFor(() => assert.equal(rowText(slot, "env-open"), "#12 open"));
      assert.equal(rowText(slot, "env-absent"), "none");
      assert.equal(rowText(slot, "env-offline"), "none");
      // A row without an environment has nothing to read.
      assert.equal(rowText(slot, "none"), "none");
      const reads = slot.inspection.rpcCalls.filter((call) => call.method === "pullRequests");
      assert.ok(reads.length > 0);
      // Rows that mount together share one batched read, and no read names a
      // row without an environment.
      assert.deepEqual(
        [...new Set(reads.flatMap((call) => (call.input as { keys: string[] }).keys))].sort(),
        ["env-absent", "env-offline", "env-open"],
      );
    });

    it("shows nothing when GitHub PR Status cannot answer", async () => {
      const slot = renderSlot(
        { component: PullRequestProbe },
        { environmentIds: ["env-open"] },
        {
          rpc: {
            pullRequests: () => {
              throw new Error("plugin bb--github-pr-status is disabled");
            },
          },
        },
      );
      await waitFor(() =>
        assert.ok(slot.inspection.rpcCalls.some((call) => call.method === "pullRequests")),
      );
      assert.equal(rowText(slot, "env-open"), "none");
    });
  });
}
