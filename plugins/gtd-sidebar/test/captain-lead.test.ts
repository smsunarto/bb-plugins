// HostLead's Captain icon through the SDK's real keyed query: the test
// runtime batches the rows' keys into one `icons` call and fails the whole
// read when the answer omits a key, as bb does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "bun:test";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

if (process.env.GTD_CAPTAIN_LEAD_TEST_CHILD !== "1") {
  it("the Captain lead passes the isolated React suite", () => {
    const child = spawnSync(
      process.execPath,
      ["test", "--timeout=30000", fileURLToPath(import.meta.url)],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, GTD_CAPTAIN_LEAD_TEST_CHILD: "1" },
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
  const { act, cleanup, waitFor } = await import("@testing-library/react");
  const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  installTestPluginRuntime();
  const { createElement, Fragment } = await import("react");
  const { HostLead } = await import("../components/inbox/thread-details.tsx");

  afterEach(() => cleanup());

  const REMOTE = { id: "remote-host", name: "Remote computer" };
  type Row = Pick<PluginSidebarThread, "id" | "host" | "originPluginId">;
  const captain = (id: string): Row => ({ id, host: REMOTE, originPluginId: "captain" });
  const plain = (id: string): Row => ({ id, host: REMOTE, originPluginId: null });

  function Rows({ rows }: { rows: readonly Row[] }) {
    return createElement(
      Fragment,
      null,
      rows.map((row) =>
        createElement(
          "div",
          { key: row.id, "data-row": row.id },
          createElement(HostLead, { thread: row }),
        ),
      ),
    );
  }

  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  /** Rows over a Captain whose `icons` answers from `answer`, read by key. */
  function mount(rows: readonly Row[], answer: (key: string) => unknown | Promise<unknown>) {
    const reads: string[][] = [];
    const slot = renderSlot(
      { component: Rows },
      { rows },
      {
        pluginId: "gtd-sidebar",
        rpc: {
          icons: async ({ keys }: { keys: string[] }) => {
            reads.push([...keys].sort());
            const entries = await Promise.all(keys.map(async (key) => [key, await answer(key)]));
            return Object.fromEntries(entries);
          },
        } as never,
      },
    );
    const lead = (id: string) =>
      slot.container.querySelector(`[data-row="${id}"] .gtd-host-lead`) as HTMLElement | null;
    const globe = (id: string) => lead(id)?.querySelector('[data-icon="Globe"]') ?? null;
    return { slot, reads, lead, globe };
  }

  describe("a Captain's lead", () => {
    it("draws each live Captain's icon from one batched read; other rows keep the globe", async () => {
      const icons: Record<string, unknown> = {
        thr_a: { kind: "image", src: PNG },
        thr_b: { kind: "icon", name: "Star" },
        thr_c: { kind: "default" },
        // An archived Captain: Captain answers null for it.
        thr_old: null,
      };
      const view = mount(
        [captain("thr_a"), captain("thr_b"), captain("thr_c"), captain("thr_old"), plain("thr_x")],
        (key) => icons[key] ?? null,
      );
      await waitFor(() => assert.equal(view.lead("thr_a")?.dataset.captainIcon, "image"));
      assert.equal(view.lead("thr_a")?.querySelector("img")?.getAttribute("src"), PNG);
      assert.equal(view.lead("thr_b")?.dataset.captainIcon, "icon");
      assert.ok(view.lead("thr_b")?.querySelector('[data-icon="Star"]'));
      assert.equal(view.lead("thr_c")?.dataset.captainIcon, "default");
      assert.ok(view.lead("thr_c")?.querySelector('[data-icon="captain/captain"]'));
      assert.equal(view.lead("thr_a")?.getAttribute("aria-label"), "Captain, on Remote computer");
      assert.ok(view.globe("thr_old"));
      assert.ok(view.globe("thr_x"));
      // Only Captain-started rows ask, in one read.
      assert.deepEqual(view.reads, [["thr_a", "thr_b", "thr_c", "thr_old"]]);
    });

    it("archiving one Captain leaves the other Captains' icons alone", async () => {
      let archived = false;
      const view = mount([captain("thr_a"), captain("thr_b")], (key) =>
        key === "thr_b" && archived
          ? null
          : { kind: "icon", name: key === "thr_a" ? "Star" : "Target" },
      );
      await waitFor(() => assert.equal(view.lead("thr_b")?.dataset.captainIcon, "icon"));
      archived = true;
      await act(() => view.slot.experimental_invalidateRpc(["icon:thr_b"], "captain"));
      await waitFor(() => assert.ok(view.globe("thr_b")));
      assert.equal(view.lead("thr_a")?.dataset.captainIcon, "icon");
      assert.ok(view.lead("thr_a")?.querySelector('[data-icon="Star"]'));
    });

    it("holds an empty lead while the read loads, so the title does not move", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const view = mount([captain("thr_a")], async () => {
        await held;
        return { kind: "default" };
      });
      await waitFor(() => assert.equal(view.lead("thr_a")?.dataset.captainIcon, "loading"));
      assert.equal(view.globe("thr_a"), null);
      release();
      await waitFor(() => assert.equal(view.lead("thr_a")?.dataset.captainIcon, "default"));
    });

    it.each([
      ["Captain is disabled", () => Promise.reject(new Error("plugin captain is not loaded"))],
      ["the row is in a shape it doesn't know", () => ({ kind: "emoji", text: "⚓" })],
      ["the row is an SVG", () => ({ kind: "image", src: "data:image/svg+xml;base64,PHN2Zy8+" })],
    ])("falls back to the globe, with no error UI, when %s", async (_, answer) => {
      const view = mount([captain("thr_a"), captain("thr_b")], answer);
      await waitFor(() => assert.ok(view.globe("thr_a")));
      assert.ok(view.globe("thr_b"));
      assert.equal(view.lead("thr_a")?.getAttribute("aria-label"), "On Remote computer");
      assert.equal(view.slot.container.querySelector("img"), null);
      assert.doesNotMatch(view.slot.container.textContent ?? "", /not loaded|error/iu);
    });
  });
}
