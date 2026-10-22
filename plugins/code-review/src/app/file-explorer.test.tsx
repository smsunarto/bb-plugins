import "../../test/dom.ts";
import { expect, test } from "bun:test";
import { FileExplorer } from "./file-explorer.tsx";

const { fireEvent, waitFor } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

const files = [
  { path: "README.md", status: "modified" as const },
  { path: "src/one.ts", status: "added" as const },
  { path: "src/two.ts", status: "removed" as const },
];

async function explorer(initialFiles = files) {
  const calls: string[] = [];
  const slot = renderSlot(
    { component: FileExplorer },
    {
      files: initialFiles,
      current: null,
      onSelect: (path: string) => calls.push(path),
    },
  );
  const host = slot.container.querySelector("file-tree-container")!;
  await waitFor(() => expect(host?.shadowRoot?.querySelector('[role="treeitem"]')).toBeTruthy());
  const row = (path: string) =>
    host.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${path}"]`)!;
  return { slot, host, row, calls };
}

test("the explorer groups files by folder, opens files, and has no review checkboxes", async () => {
  const { slot, host, row, calls } = await explorer();
  try {
    expect(row("src/").getAttribute("aria-expanded")).toBe("true");
    expect(host.shadowRoot!.querySelector('input[type="checkbox"]')).toBeNull();
    fireEvent.click(row("src/one.ts"));
    await waitFor(() => expect(calls).toEqual(["src/one.ts"]));
    fireEvent.click(row("src/one.ts"));
    await waitFor(() => expect(calls).toEqual(["src/one.ts", "src/one.ts"]));
    expect(row("src/two.ts").getAttribute("data-item-git-status")).toBe("deleted");
    fireEvent.click(row("src/"));
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("false"));
    expect(calls).toHaveLength(2);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("keyboard activation opens a file and programmatic selection does not navigate", async () => {
  const { slot, row, calls } = await explorer();
  try {
    // Native button keyboard activation produces a click with detail=0.
    fireEvent.click(row("src/two.ts"), { detail: 0 });
    await waitFor(() => expect(calls).toEqual(["src/two.ts"]));
    slot.lifecycle.rerender(
      <FileExplorer files={files} current="README.md" onSelect={(path) => calls.push(path)} />,
    );
    await waitFor(() => expect(row("README.md").getAttribute("aria-selected")).toBe("true"));
    expect(calls).toEqual(["src/two.ts"]);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a focus change while the click bubbles still opens the activated row", async () => {
  const { slot, host, row, calls } = await explorer();
  try {
    host.addEventListener("click", () => row("README.md").focus());
    fireEvent.click(row("src/one.ts"));
    await waitFor(() => expect(calls).toEqual(["src/one.ts"]));
  } finally {
    slot.lifecycle.unmount();
  }
});

test("unchanged paths retain collapsed folders across review and refresh updates", async () => {
  const { slot, row, calls } = await explorer();
  try {
    fireEvent.click(row("src/"));
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("false"));
    slot.lifecycle.rerender(
      <FileExplorer
        files={files.map(({ path, status }) => ({ path, status }))}
        current={null}
        onSelect={(path) => calls.push(path)}
      />,
    );
    expect(row("src/").getAttribute("aria-expanded")).toBe("false");
  } finally {
    slot.lifecycle.unmount();
  }
});

for (const status of ["removed", "added"] as const) {
  test(`file/directory replacement (${status} parent) keeps both diffs accessible`, async () => {
    const replacement = [
      { path: "config", status },
      {
        path: "config/settings.json",
        status: status === "removed" ? ("added" as const) : ("removed" as const),
      },
    ];
    const { slot, row, calls } = await explorer(replacement);
    try {
      fireEvent.click(row(status === "removed" ? "config (deleted file)" : "config (file)"));
      fireEvent.click(row("config/settings.json"));
      await waitFor(() => expect(calls).toEqual(["config", "config/settings.json"]));
    } finally {
      slot.lifecycle.unmount();
    }
  });
}

test("current-file navigation expands ancestors and an explicit reveal can reopen the same path", async () => {
  const { slot, host, row, calls } = await explorer();
  try {
    fireEvent.click(row("src/"));
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("false"));
    const keyboardFocus = host.shadowRoot!.activeElement;
    const update = (reveal: { path: string } | null) =>
      slot.lifecycle.rerender(
        <FileExplorer
          files={files}
          current="src/two.ts"
          reveal={reveal}
          onSelect={(path) => calls.push(path)}
        />,
      );
    update(null);
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("true"));
    expect(row("src/two.ts").getAttribute("aria-selected")).toBe("true");
    expect(host.shadowRoot!.activeElement).toBe(keyboardFocus);
    fireEvent.click(row("src/"));
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("false"));
    update({ path: "src/two.ts" });
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("true"));
    expect(calls).toEqual([]);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("filtering temporarily reveals matches and clearing it restores collapsed folders", async () => {
  const { slot, row, calls } = await explorer();
  try {
    fireEvent.click(row("src/"));
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("false"));
    slot.lifecycle.rerender(
      <FileExplorer
        files={[files[1]!]}
        current={null}
        filtering
        onSelect={(path) => calls.push(path)}
      />,
    );
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("true"));
    slot.lifecycle.rerender(
      <FileExplorer files={files} current={null} onSelect={(path) => calls.push(path)} />,
    );
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("false"));
    // A new visible diff after clearing the filter is a layout update, rather
    // than a request to reopen its ancestors.
    slot.lifecycle.rerender(
      <FileExplorer files={files} current="src/two.ts" onSelect={(path) => calls.push(path)} />,
    );
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("false"));
    fireEvent.wheel(document);
    slot.lifecycle.rerender(
      <FileExplorer files={files} current="src/one.ts" onSelect={(path) => calls.push(path)} />,
    );
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("true"));
    fireEvent.click(row("src/"));
    slot.lifecycle.rerender(
      <FileExplorer
        files={[...files, { path: "src/new.ts", status: "added" }]}
        current={null}
        onSelect={(path) => calls.push(path)}
      />,
    );
    await waitFor(() => expect(row("src/").getAttribute("aria-expanded")).toBe("false"));
    expect(calls).toEqual([]);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("row decorations retain comment counts and line deltas and refresh independently of Git status", async () => {
  const { slot, row, calls } = await explorer();
  try {
    const stats = files.map(({ path, status }) => ({ path, status, additions: 4, deletions: 1 }));
    slot.lifecycle.rerender(
      <FileExplorer
        files={stats}
        current={null}
        threadsByPath={new Map([["src/one.ts", 2]])}
        onSelect={(path) => calls.push(path)}
      />,
    );
    await waitFor(() => expect(row("src/one.ts").textContent).toContain("2 comments"));
    expect(row("src/one.ts").textContent).toContain("+4");
    expect(row("src/one.ts").textContent).toContain("−1");
    slot.lifecycle.rerender(
      <FileExplorer
        files={stats}
        current={null}
        threadsByPath={new Map([["src/one.ts", 3]])}
        onSelect={(path) => calls.push(path)}
      />,
    );
    await waitFor(() => expect(row("src/one.ts").textContent).toContain("3 comments"));
  } finally {
    slot.lifecycle.unmount();
  }
});
