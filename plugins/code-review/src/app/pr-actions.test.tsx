import "../../test/dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query.ts";
import { inbox, pullRequest as pr } from "../../test/app-fixtures.ts";
import { PrActions } from "./pr-actions.tsx";
import { queryKey } from "./rpc.ts";
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
beforeEach(() => queryClient.clear());
const policy = {
  state: "OPEN",
  isDraft: false,
  headRefOid: pr.headRefOid,
  baseRefName: pr.baseRefName,
  mergeStateStatus: "CLEAN",
  canUpdate: true,
  canMerge: true,
  methods: ["squash"],
};
function Component() {
  return (
    <QueryClientProvider client={queryClient}>
      <PrActions pr={pr} />
    </QueryClientProvider>
  );
}

test("a write still invalidates all account copies after the panel unmounts", async () => {
  const key = queryKey("pullRequest", { account: "another-account", ref: pr.ref });
  queryClient.setQueryData(key, { ...pr, account: "another-account" });
  queryClient.setQueryData(queryKey("inbox"), inbox);
  let finish!: (value: { message: string }) => void;
  let writes = 0;
  const pending = new Promise<{ message: string }>((resolve) => {
    finish = resolve;
  });
  const slot = renderSlot(
    { component: Component },
    {},
    {
      rpc: {
        prActionState: () => policy,
        prAction: () => {
          writes++;
          return pending;
        },
      },
    },
  );
  fireEvent.click(slot.getByRole("button", { name: "Merge PR" }));
  const dialog = within(await slot.findByRole("dialog"));
  const confirm = dialog.getByRole("button", { name: "Merge PR" }) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  expect(dialog.getByText(/Destination:/).textContent).toContain(pr.baseRefName);
  fireEvent.click(confirm);
  await waitFor(() => expect(writes).toBe(1));
  slot.lifecycle.unmount();
  finish({ message: "Merged" });
  await waitFor(() => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true));
  expect(queryClient.getQueryState(queryKey("inbox"))?.isInvalidated).toBe(true);
});

test("a freshly retargeted PR cannot be confirmed from the old dialog", async () => {
  let writes = 0;
  const slot = renderSlot(
    { component: Component },
    {},
    {
      rpc: {
        prActionState: () => ({ ...policy, baseRefName: "release" }),
        prAction: () => {
          writes++;
          return { message: "Merged" };
        },
      },
    },
  );
  try {
    fireEvent.click(slot.getByRole("button", { name: "Merge PR" }));
    const dialog = within(await slot.findByRole("dialog"));
    await dialog.findByText("The destination branch changed. Refresh before merging.");
    expect((dialog.getByRole("button", { name: "Merge PR" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(writes).toBe(0);
  } finally {
    slot.lifecycle.unmount();
  }
});
