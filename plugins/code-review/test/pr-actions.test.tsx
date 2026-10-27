import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { PrActions } from "../src/app/pr-actions.tsx";
import { pullRequest } from "./app-fixtures.ts";
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
beforeEach(() => pluginQueryClient.clear());

test("an open merge dialog refreshes unknown mergeability until GitHub computes it", async () => {
  let reads = 0;
  const slot = renderSlot(
    { component: PrActions },
    { pr: pullRequest },
    {
      rpc: {
        prActionState: () => ({
          state: "OPEN",
          isDraft: false,
          headRefOid: pullRequest.headRefOid,
          baseRefName: pullRequest.baseRefName,
          mergeStateStatus: ++reads === 1 ? "UNKNOWN" : "CLEAN",
          canUpdate: true,
          canMerge: true,
          methods: ["squash"],
        }),
      },
    },
  );
  try {
    fireEvent.click(slot.getByRole("button", { name: "Merge PR" }));
    await slot.findByText(/GitHub blocks merging: UNKNOWN/);
    const dialog = slot.getByRole("dialog");
    await waitFor(
      () =>
        expect(
          within(dialog)
            .getByRole("button", { name: "Merge PR" })
            .hasAttribute("disabled"),
        ).toBe(false),
      { timeout: 5000 },
    );
    expect(reads).toBeGreaterThanOrEqual(2);
  } finally {
    slot.lifecycle.unmount();
  }
});
