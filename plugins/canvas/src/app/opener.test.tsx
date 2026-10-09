import { afterEach, expect, it, mock } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";

installDom();
for (const name of ["Event", "CustomEvent"] as const) {
  (globalThis as Record<string, unknown>)[name] = window[name];
}
const { act, cleanup, waitFor } = await import("@testing-library/react");
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { $getNearestNodeFromDOMNode, $isTextNode, getNearestEditorFromDOMNode } =
  await import("lexical");
installTestPluginRuntime();
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.matchMedia = ((media: string) => ({
  matches: false,
  media,
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia;
const { MdxOpener } = await import("./opener.tsx");

afterEach(() => {
  cleanup();
});

const props: PluginFileOpenerProps = {
  path: "notes/guide.mdx",
  source: { kind: "workspace", environmentId: "env-1", threadId: null, projectId: null },
  Original: () => <pre>ORIGINAL</pre>,
};

function openWith(
  disk: { content: string; sha256: string },
  options: { beforeSave?: () => Promise<void> } = {},
) {
  const save = mock((raw: unknown) => {
    const write = () => {
      const input = raw as { content: string; expectedSha256?: string };
      if (input.expectedSha256 !== disk.sha256) return { outcome: "conflict" };
      disk.content = input.content;
      disk.sha256 = `saved-${input.content.length}`;
      return { outcome: "written", sha256: disk.sha256 };
    };
    return options.beforeSave ? options.beforeSave().then(write) : write();
  });
  const file = mock((raw: unknown) =>
    (raw as { knownSha256: string | null }).knownSha256 === disk.sha256
      ? { status: "unchanged", sha256: disk.sha256 }
      : { status: "read", sha256: disk.sha256, content: disk.content },
  );
  const slot = renderSlot({ component: MdxOpener }, props, {
    rpc: {
      file,
      save,
      preview: () => ({ baseUrl: "/preview", expiresAtMs: 1, path: "notes/guide.mdx" }),
    },
  });
  return { slot, file, save };
}

async function replaceText(element: HTMLElement, text: string) {
  const editor = getNearestEditorFromDOMNode(element);
  if (!editor) throw new Error("Editor is not mounted");
  await act(async () =>
    editor.update(
      () => {
        const node = $getNearestNodeFromDOMNode(element.firstChild ?? element);
        if (!$isTextNode(node)) throw new Error("Expected text");
        node.setTextContent(text);
      },
      { discrete: true },
    ),
  );
}

it("saves an edit against the hash it opened", async () => {
  const disk = { content: "# Guide\n\nOriginal paragraph.\n", sha256: "v1" };
  const { slot, save } = openWith(disk);
  await replaceText(await slot.findByText("Original paragraph."), "Edited paragraph.");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    source: { kind: "workspace", environmentId: "env-1", path: "notes/guide.mdx" },
    expectedSha256: "v1",
  });
  expect(disk.content).toContain("Edited paragraph.");
});

it("writes an edit made while the previous save is still in flight", async () => {
  const disk = { content: "# Guide\n\nOriginal paragraph.\n", sha256: "v1" };
  let release = () => {};
  let held = false;
  const { slot, save } = openWith(disk, {
    beforeSave: () => {
      if (held) return Promise.resolve();
      held = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  await replaceText(await slot.findByText("Original paragraph."), "First edit.");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
  await replaceText(await slot.findByText("First edit."), "Second edit.");
  // The debounce fires while the first write is still pending.
  await new Promise((resolve) => setTimeout(resolve, 900));
  expect(save).toHaveBeenCalledTimes(1);
  release();
  await waitFor(() => expect(disk.content).toContain("Second edit."), { timeout: 3000 });
  expect(save.mock.calls[1]?.[0]).toMatchObject({ expectedSha256: "saved-21" });
});

it("refreshes a clean document after an external write", async () => {
  const disk = { content: "# Guide\n\nOriginal paragraph.\n", sha256: "v1" };
  const { slot, save } = openWith(disk);
  await slot.findByText("Original paragraph.");
  disk.content = "# Guide\n\nWritten by an agent.\n";
  disk.sha256 = "v2";
  await slot.findByText("Written by an agent.", undefined, { timeout: 4000 });
  expect(save).not.toHaveBeenCalled();
});

it("shows Reload and Overwrite when the file changed under an unsaved edit", async () => {
  const disk = { content: "# Guide\n\nOriginal paragraph.\n", sha256: "v1" };
  const { slot, save } = openWith(disk);
  await slot.findByText("Original paragraph.");
  disk.content = "# Guide\n\nWritten elsewhere.\n";
  disk.sha256 = "v2";
  await replaceText(await slot.findByText("Original paragraph."), "My edit.");
  await slot.findByText("Changed on disk.", undefined, { timeout: 4000 });
  expect(slot.getByRole("button", { name: "Overwrite" })).toBeTruthy();
  expect(
    save.mock.results.map((result) => (result.value as { outcome: string }).outcome),
  ).not.toContain("written");
  expect(disk.content).toContain("Written elsewhere.");
});

it("falls back to bb's preview when Canvas cannot address the file", () => {
  const slot = renderSlot(
    { component: MdxOpener },
    { ...props, source: { ...props.source, environmentId: null } },
  );
  expect(slot.getByText("ORIGINAL")).toBeTruthy();
});

const elsewhere: PluginFileOpenerProps = {
  path: "/Users/me/git/other/doc.mdx",
  // How bb opens an absolute link outside the thread's worktree and storage.
  source: { kind: "host", environmentId: "env-mac", threadId: "thr", projectId: null },
  Original: () => <pre>ORIGINAL</pre>,
};

it("reads a host file from the host of the environment that opened it", async () => {
  const file = mock((_input: unknown) => ({
    status: "read",
    sha256: "v1",
    content: "# Doc\n\nOn the Mac.\n",
  }));
  const preview = mock((_input: unknown) => ({
    baseUrl: "/preview",
    expiresAtMs: 1,
    path: "doc.mdx",
  }));
  const slot = renderSlot({ component: MdxOpener }, elsewhere, {
    rpc: { file, preview },
    sdk: { environments: { get: async () => ({ hostId: "host-mac" }) as never } },
  });
  await slot.findByText("On the Mac.");
  const source = { kind: "host", hostId: "host-mac", path: "/Users/me/git/other/doc.mdx" };
  expect(file.mock.calls[0]?.[0]).toEqual({ source, knownSha256: null });
  expect(preview.mock.calls[0]?.[0]).toEqual({ source });
});

it("keeps bb's preview when the opener cannot find the file's host", async () => {
  const file = mock(() => ({ status: "read", sha256: "v1", content: "# Doc\n" }));
  const slot = renderSlot({ component: MdxOpener }, elsewhere, {
    rpc: { file },
    sdk: {
      environments: {
        get: async () => {
          throw new Error("environment not found");
        },
      },
    },
  });
  expect(await slot.findByText("ORIGINAL")).toBeTruthy();
  expect(file).not.toHaveBeenCalled();
});

it("renews a lease about to expire when an external write reloads the embeds", async () => {
  const disk = { content: '# Guide\n\n::html{src="./page.html"}\n', sha256: "v1" };
  let leases = 0;
  const preview = mock(() => {
    leases += 1;
    // The first lease is a minute from expiry when the agent writes.
    const expiresAtMs = Date.now() + (leases === 1 ? 60_000 : 3_600_000);
    return { baseUrl: `/lease-${leases}`, expiresAtMs, path: "notes/guide.mdx" };
  });
  const file = mock((raw: unknown) =>
    (raw as { knownSha256: string | null }).knownSha256 === disk.sha256
      ? { status: "unchanged", sha256: disk.sha256 }
      : { status: "read", sha256: disk.sha256, content: disk.content },
  );
  const pages: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    pages.push(new URL(String(input)).pathname);
    return new Response("<p>page</p>");
  }) as typeof fetch;
  try {
    const slot = renderSlot({ component: MdxOpener }, props, { rpc: { file, preview } });
    await waitFor(() => expect(pages).toEqual(["/lease-1/notes/page.html"]));
    disk.content = `${disk.content}\nWritten by an agent.\n`;
    disk.sha256 = "v2";
    await slot.findByText("Written by an agent.", undefined, { timeout: 4000 });
    await waitFor(() => expect(pages.at(-1)).toBe("/lease-2/notes/page.html"));
    expect(preview).toHaveBeenCalledTimes(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
