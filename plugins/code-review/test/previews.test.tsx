import "./dom.ts";
import { beforeEach, expect, test } from "bun:test";
import { PluginQueryBoundary, pluginQueryClient } from "@bb-kit/core/rpc/query";
import type { ChangedFile, Comparison, FileBlobs, UnityPreview } from "../src/shared/schema.ts";
import { pullRequest as pr } from "./app-fixtures.ts";

const { fireEvent, waitFor } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { DiffFile } = await import("../src/app/diff-file.tsx");

beforeEach(() => {
  pluginQueryClient.clear();
});

const comparison: Comparison = {
  kind: "github",
  account: "scott",
  owner: "acme",
  repo: "game",
  headRepository: null,
  base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  head: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
};
const OID = "3de81c8fa10429766e005b1216577e39e407259209e3a698ab53aa35719c359a";
const NEXT = `${"0".repeat(63)}1`;

function file(overrides: Partial<ChangedFile>): ChangedFile {
  return {
    path: "Art/hero.png",
    previousPath: null,
    status: "modified",
    additions: 0,
    deletions: 0,
    viewed: "unviewed",
    generated: false,
    patch: null,
    ...overrides,
  };
}

function mount(
  shown: ChangedFile,
  rpc: { fileBlobs?: () => FileBlobs; unityPreview?: () => UnityPreview },
  withComparison: Comparison | null = comparison,
) {
  const View = () => (
    <PluginQueryBoundary>
      <DiffFile
        pr={pr}
        file={shown}
        headRefOid={comparison.head}
        baseRefName="main"
        threads={[]}
        findings={[]}
        findingsStale={false}
        open
        diffStyle="unified"
        focus={null}
        onOpenChange={() => {}}
        onViewedChange={() => {}}
        comparison={withComparison}
      />
    </PluginQueryBoundary>
  );
  return renderSlot({ component: View }, {}, { rpc: rpc as never, pluginId: "code-review" });
}

const both: FileBlobs = {
  base: { kind: "blob", size: 2048, lfs: null },
  head: { kind: "blob", size: 4096, lfs: null },
};

test("a changed image shows both versions from the review's pinned commits, in any compare mode", async () => {
  const slot = mount(file({}), { fileBlobs: () => both });
  const before = (await slot.findByAltText("Before version")) as HTMLImageElement;
  const after = slot.getByAltText("After version") as HTMLImageElement;
  expect(before.getAttribute("src")).toStartWith("/api/v1/plugins/code-review/http/blob?");
  const params = (image: HTMLImageElement) => new URL(image.src, "http://bb").searchParams;
  expect(params(before).get("side")).toBe("base");
  expect(params(after).get("side")).toBe("head");
  expect(params(after).get("head")).toBe(comparison.head);
  expect(params(after).get("path")).toBe("Art/hero.png");
  expect(slot.getByText(/2\.0 KB → 4\.0 KB/)).toBeDefined();

  // Each side covers only its share, so a transparent pixel never shows the other version.
  fireEvent.click(slot.getByRole("button", { name: "Swipe" }));
  fireEvent.change(slot.getByRole("slider"), { target: { value: "30" } });
  expect(slot.getByAltText("Before version").style.clipPath).toBe("inset(0 70% 0 0)");
  expect(slot.getByAltText("After version").style.clipPath).toBe("inset(0 0 0 30%)");
  fireEvent.click(slot.getByRole("button", { name: "Onion skin" }));
  expect(slot.getByText("Opacity")).toBeDefined();
  expect(slot.getByAltText("Before version").style.opacity).toBe("0.7");
  expect(slot.getByAltText("After version").style.opacity).toBe("0.3");
  slot.lifecycle.unmount();
});

test("an added image has no before, and no compare modes", async () => {
  const slot = mount(file({ status: "added" }), {
    fileBlobs: () => ({ base: { kind: "missing" }, head: { kind: "blob", size: 10, lfs: null } }),
  });
  expect(await slot.findByAltText("After version")).toBeDefined();
  expect(slot.queryByAltText("Before version")).toBeNull();
  expect(slot.queryByRole("button", { name: "Swipe" })).toBeNull();
  // An added file has one size; the header already says it is new.
  expect(slot.getAllByText("10 B").length).toBeGreaterThan(0);
  expect(slot.queryByText(/→/)).toBeNull();
  slot.lifecycle.unmount();
});

test("a Git LFS file is marked LFS, previews its objects, and keeps its pointer diff a click away", async () => {
  const patch = [
    "@@ -1,3 +1,3 @@",
    " version https://git-lfs.github.com/spec/v1",
    `-oid sha256:${OID}`,
    "-size 2048",
    `+oid sha256:${NEXT}`,
    "+size 4096",
  ].join("\n");
  const slot = mount(file({ patch, additions: 2, deletions: 2 }), {
    fileBlobs: () => ({
      base: { kind: "blob", size: 130, lfs: { oid: OID, size: 2048 } },
      head: { kind: "blob", size: 130, lfs: { oid: NEXT, size: 4096 } },
    }),
  });
  expect(slot.getByText("LFS")).toBeDefined();
  expect(await slot.findByText(/Stored with Git LFS/)).toBeDefined();
  expect(slot.getByAltText("After version")).toBeDefined();
  const views = slot.getByRole("group", { name: "Show Art/hero.png as" });
  fireEvent.click(views.querySelector("button[aria-pressed=false]")!);
  await waitFor(() => expect(slot.queryByAltText("After version")).toBeNull());
  slot.lifecycle.unmount();
});

const prefabPatch = "@@ -1 +1 @@\n-  speed: 5\n+  speed: 8";

test("a Unity prefab shows its changed objects and properties", async () => {
  const slot = mount(
    file({ path: "Assets/Player.prefab", patch: prefabPatch, additions: 1, deletions: 1 }),
    {
      unityPreview: () => ({
        state: "objects",
        diff: {
          propertyCount: 1,
          groups: [
            {
              id: "1",
              name: "Player",
              hierarchy: "",
              status: "modified",
              components: [
                {
                  id: "2",
                  type: "PlayerMovement",
                  status: "modified",
                  properties: [{ path: "speed", before: "5", after: "8" }],
                },
              ],
            },
          ],
        },
      }),
    },
  );
  expect(await slot.findByText("Prefab changes")).toBeDefined();
  expect(slot.getByText("PlayerMovement")).toBeDefined();
  expect(slot.getByText("8")).toBeDefined();
  // The card's own toggle holds the text view; the inspector draws none of its own.
  expect(slot.queryByRole("button", { name: "Raw YAML" })).toBeNull();
  slot.lifecycle.unmount();
});

test("a Unity asset that cannot show as objects says why and opens its text diff", async () => {
  const slot = mount(
    file({ path: "Assets/Lighting.asset", patch: prefabPatch, additions: 1, deletions: 1 }),
    {
      unityPreview: () => ({
        state: "unavailable",
        reason: "This asset is not saved as Unity text YAML.",
      }),
    },
  );
  expect(await slot.findByText("This asset is not saved as Unity text YAML.")).toBeDefined();
  fireEvent.click(slot.getByRole("button", { name: "Show the text diff" }));
  await waitFor(() =>
    expect(slot.queryByText("This asset is not saved as Unity text YAML.")).toBeNull(),
  );
  slot.lifecycle.unmount();
});

test("without a pinned comparison, a file shows only its text diff, as before", () => {
  const slot = mount(file({ path: "Assets/Player.prefab", patch: prefabPatch }), {}, null);
  expect(slot.queryByRole("group", { name: "Show Assets/Player.prefab as" })).toBeNull();
  expect(slot.queryByText("Prefab changes")).toBeNull();
  slot.lifecycle.unmount();
});

test("an image that fails to load says why and loads again on retry", async () => {
  const slot = mount(file({}), { fileBlobs: () => both });
  fireEvent.error(await slot.findByAltText("After version"));
  const retry = await slot.findByRole("button", { name: "Try again" });
  fireEvent.click(retry);
  expect(await slot.findByAltText("After version")).toBeDefined();
  slot.lifecycle.unmount();
});

test("a binary Unity asset with no text diff offers its downloads instead", async () => {
  const slot = mount(file({ path: "Assets/LightingData.asset", patch: null }), {
    unityPreview: () => ({
      state: "unavailable",
      reason: "This asset is not saved as Unity text YAML, or its YAML could not be read.",
    }),
    fileBlobs: () => both,
  });
  expect(await slot.findByText(/not saved as Unity text YAML/)).toBeDefined();
  expect(slot.queryByRole("button", { name: "Show the text diff" })).toBeNull();
  expect(await slot.findByText("Download after")).toBeDefined();
  slot.lifecycle.unmount();
});
