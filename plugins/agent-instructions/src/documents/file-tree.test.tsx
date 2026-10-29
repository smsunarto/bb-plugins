import { installDom } from "@bb-plugins/testing";
import { expect, test } from "bun:test";
installDom();
const { DocumentTree } = await import("./file-tree.tsx");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, waitFor } = await import("@testing-library/react");
const paths = [
  "AGENTS.md",
  ".agents/skills/review/SKILL.md",
  ".agents/skills/review/references/AGENTS.md",
];

async function tree() {
  const calls: string[] = [];
  const onOpen = (path: string) => calls.push(path);
  const slot = renderSlot(
    { component: DocumentTree },
    { paths, selectedPath: "AGENTS.md", filtering: false, onOpen },
  );
  const host = slot.container.querySelector("file-tree-container")!;
  const row = (path: string) =>
    host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
  await waitFor(() => expect(row("AGENTS.md")).toBeTruthy());
  const update = (selectedPath: string, filtering = false, files = paths) =>
    slot.lifecycle.rerender(
      <DocumentTree
        paths={files}
        selectedPath={selectedPath}
        filtering={filtering}
        onOpen={onOpen}
      />,
    );
  return { slot, row, calls, update };
}

test("tree activation uses full paths and route selection never opens another file", async () => {
  const { slot, row, calls, update } = await tree();
  try {
    const reference = paths[2]!;
    fireEvent.click(row(reference)!);
    fireEvent.click(row("AGENTS.md")!, { detail: 0 });
    expect(calls).toEqual([reference, "AGENTS.md"]);
    update(reference);
    await waitFor(() => expect(row(reference)?.getAttribute("aria-selected")).toBe("true"));
    expect(row("AGENTS.md")?.getAttribute("aria-selected")).toBe("false");
    expect(calls).toEqual([reference, "AGENTS.md"]);
  } finally {
    slot.unmount();
  }
});

test("search reveals matches then restores collapsed folders, while route changes reveal a file", async () => {
  const { slot, row, update } = await tree();
  try {
    const folder = ".agents/skills/review/";
    fireEvent.click(row(folder)!);
    await waitFor(() => expect(row(folder)?.getAttribute("aria-expanded")).toBe("false"));
    update("AGENTS.md", true, [paths[2]!]);
    await waitFor(() => expect(row(paths[2]!)).toBeTruthy());
    update("AGENTS.md");
    await waitFor(() => expect(row(folder)?.getAttribute("aria-expanded")).toBe("false"));
    update(paths[2]!);
    await waitFor(() => expect(row(paths[2]!)?.getAttribute("aria-selected")).toBe("true"));
  } finally {
    slot.unmount();
  }
});

test("returning from an unlisted new file reveals the previous route and waits for new files", async () => {
  const { slot, row, update } = await tree();
  try {
    const nested = paths[2]!;
    const folder = ".agents/skills/review/";
    update(nested);
    await waitFor(() => expect(row(nested)?.getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(row(folder)!);
    await waitFor(() => expect(row(folder)?.getAttribute("aria-expanded")).toBe("false"));
    const newFile = ".agents/skills/review/references/new.md";
    update(newFile);
    update(nested);
    await waitFor(() => expect(row(nested)?.getAttribute("aria-selected")).toBe("true"));
    expect(row(folder)?.getAttribute("aria-expanded")).toBe("true");
    update(newFile);
    fireEvent.click(row(folder)!);
    update(newFile, false, [...paths, newFile]);
    await waitFor(() => expect(row(newFile)?.getAttribute("aria-selected")).toBe("true"));
    expect(row(folder)?.getAttribute("aria-expanded")).toBe("true");
  } finally {
    slot.unmount();
  }
});

test("a file opened from search stays visible when the search is cleared", async () => {
  const { slot, row, update } = await tree();
  try {
    const folder = ".agents/skills/review/";
    const nested = paths[2]!;
    fireEvent.click(row(folder)!);
    await waitFor(() => expect(row(folder)?.getAttribute("aria-expanded")).toBe("false"));
    update("AGENTS.md", true, [nested]);
    update(nested, true, [nested]);
    await waitFor(() => expect(row(nested)?.getAttribute("aria-selected")).toBe("true"));
    update(nested);
    await waitFor(() => expect(row(nested)?.getAttribute("aria-selected")).toBe("true"));
    expect(row(folder)?.getAttribute("aria-expanded")).toBe("true");
  } finally {
    slot.unmount();
  }
});

test("browsing a folder uses native tree selection without opening a file", async () => {
  const { slot, row, calls } = await tree();
  try {
    const folder = ".agents/skills/review/";
    fireEvent.click(row(folder)!);
    await waitFor(() => expect(row(folder)?.getAttribute("aria-selected")).toBe("true"));
    expect(calls).toEqual([]);
  } finally {
    slot.unmount();
  }
});
