import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { installDom } from "../testing/testing.ts";
import { defineMutation, defineQuery, defineRPC } from "../rpc/rpc.ts";

// Tier-3 order (§8): DOM first, then the SDK test runtime, then any
// module that imports @get-bb/plugin-sdk/app — the app facade binds
// globalThis.__bbPluginRuntime AT IMPORT TIME, so ./query.ts must be
// imported dynamically after installTestPluginRuntime().
installDom();
const { installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { createRPC, PluginQueryBoundary } = await import("./query.ts");
const { cleanup, render, screen } = await import("@testing-library/react");
const { QueryClient, useQuery: useTanStackQuery } = await import("@tanstack/react-query");
const { StrictMode, createElement, useEffect, useRef, useState } = await import("react");
type ReactNode = import("react").ReactNode;

const demoRPC = defineRPC({
  namespace: "demo",
  procedures: {
    overview: defineQuery({
      output: z.object({ total: z.number() }),
      handler: () => ({ total: 0 }),
    }),
    readFile: defineQuery({
      input: z.object({ path: z.string() }),
      output: z.object({ content: z.string() }),
      handler: (_context: unknown, input) => ({ content: input.path }),
    }),
    saveFile: defineMutation({
      input: z.object({ path: z.string() }),
      output: z.object({ saved: z.boolean() }),
      handler: () => ({ saved: true }),
    }),
  },
});

type DemoRPC = typeof demoRPC;
const rpc = createRPC<DemoRPC>("demo");

function boundary(children: ReactNode) {
  return () => createElement(PluginQueryBoundary, null, children);
}

// ---- type-level checks (§5 discriminant; never invoked) -------------

function typeChecks() {
  // @ts-expect-error — a Mutation accessor has no useQuery
  void rpc.saveFile.useQuery;
  // @ts-expect-error — a Query accessor has no useMutation
  void rpc.overview.useMutation;
  // @ts-expect-error — a with-input Query REQUIRES its input
  rpc.readFile.useQuery();
  // @ts-expect-error — a no-input useQuery takes options, not an input
  rpc.overview.useQuery({ path: "x" });
  // @ts-expect-error — the namespace argument is the RPC's literal
  createRPC<DemoRPC>("not-demo");
  const key: readonly unknown[] = rpc.readFile.queryKey({ path: "a" });
  return key;
}
void typeChecks;

// ---- runtime, through the SDK tier-3 harness ------------------------

test("no-input useQuery calls the wire name with null input", async (t) => {
  // Unmount even on failure — a lingering QueryClient's gcTime timers
  // (5 minutes) would otherwise keep the test child process alive.
  t.after(cleanup);
  function OverviewPanel() {
    const overview = rpc.overview.useQuery();
    return createElement(
      "div",
      null,
      overview.status === "success" ? `total:${overview.data.total}` : overview.status,
    );
  }
  const slot = renderSlot(
    { component: boundary(createElement(OverviewPanel)) },
    {},
    { rpc: { demo_overview: () => ({ total: 7 }) } },
  );
  await slot.findByText("total:7");
  assert.deepEqual(slot.rpcCalls, [{ method: "demo_overview", input: null }]);
  assert.deepEqual(rpc.overview.queryKey(), ["demo", "overview"]);
  slot.unmount();
});

test("with-input useQuery(input) sends the input and derives the key", async (t) => {
  t.after(cleanup);
  function ReadFilePanel() {
    const file = rpc.readFile.useQuery({ path: "notes.md" });
    return createElement(
      "div",
      null,
      file.status === "success" ? `content:${file.data.content}` : file.status,
    );
  }
  const slot = renderSlot(
    { component: boundary(createElement(ReadFilePanel)) },
    {},
    { rpc: { demo_read_file: (input) => ({ content: (input as { path: string }).path }) } },
  );
  await slot.findByText("content:notes.md");
  assert.deepEqual(slot.rpcCalls, [{ method: "demo_read_file", input: { path: "notes.md" } }]);
  assert.deepEqual(rpc.readFile.queryKey({ path: "notes.md" }), [
    "demo",
    "readFile",
    { path: "notes.md" },
  ]);
  assert.deepEqual(rpc.readFile.queryKey(), ["demo", "readFile"]);
  slot.unmount();
});

test("no-input useQuery(options) reads a sole options object as options", async (t) => {
  t.after(cleanup);
  function DisabledPanel() {
    const overview = rpc.overview.useQuery({ enabled: false });
    return createElement("div", null, `disabled:${overview.status}:${overview.fetchStatus}`);
  }
  const slot = renderSlot(
    { component: boundary(createElement(DisabledPanel)) },
    {},
    { rpc: { demo_overview: () => ({ total: 0 }) } },
  );
  await slot.findByText("disabled:pending:idle");
  assert.equal(slot.rpcCalls.length, 0);
  slot.unmount();
});

test("useQuery(input, options) passes options through to TanStack", async (t) => {
  t.after(cleanup);
  function FailingPanel() {
    const file = rpc.readFile.useQuery({ path: "boom.md" }, { retry: false });
    return createElement(
      "div",
      null,
      file.status === "error" ? `readfail:${file.error.message}` : file.status,
    );
  }
  const slot = renderSlot(
    { component: boundary(createElement(FailingPanel)) },
    {},
    {
      rpc: {
        demo_read_file: () => {
          throw new Error("nope");
        },
      },
    },
  );
  // No DOM lib in tsconfig — read textContent through a structural cast.
  const element = (await slot.findByText(/readfail:/)) as unknown as {
    textContent: string | null;
  };
  assert.match(element.textContent ?? "", /nope/);
  assert.equal(slot.rpcCalls.length, 1);
  slot.unmount();
});

test("useMutation sends variables over the wire", async (t) => {
  t.after(cleanup);
  function SavePanel() {
    const save = rpc.saveFile.useMutation();
    const fired = useRef(false);
    useEffect(() => {
      if (!fired.current) {
        fired.current = true;
        save.mutate({ path: "out.md" });
      }
    }, [save]);
    return createElement(
      "div",
      null,
      save.status === "success" ? `saved:${String(save.data.saved)}` : save.status,
    );
  }
  const slot = renderSlot(
    { component: boundary(createElement(SavePanel)) },
    {},
    { rpc: { demo_save_file: () => ({ saved: true }) } },
  );
  await slot.findByText("saved:true");
  assert.deepEqual(slot.rpcCalls, [{ method: "demo_save_file", input: { path: "out.md" } }]);
  slot.unmount();
});

test("useClient is the imperative escape hatch", async (t) => {
  t.after(cleanup);
  function ClientPanel() {
    const client = rpc.useClient();
    const [content, setContent] = useState("pending");
    const fired = useRef(false);
    useEffect(() => {
      if (fired.current) {
        return;
      }
      fired.current = true;
      client
        .readFile({ path: "via-client.md" })
        .then((result) => {
          setContent(result.content);
        })
        .catch((error: unknown) => {
          setContent(`failed:${String(error)}`);
        });
    }, [client]);
    return createElement("div", null, `client:${content}`);
  }
  const slot = renderSlot(
    { component: boundary(createElement(ClientPanel)) },
    {},
    { rpc: { demo_read_file: (input) => ({ content: (input as { path: string }).path }) } },
  );
  await slot.findByText("client:via-client.md");
  assert.deepEqual(slot.rpcCalls, [{ method: "demo_read_file", input: { path: "via-client.md" } }]);
  slot.unmount();
});

test("an owned client survives a StrictMode double mount", async (t) => {
  t.after(cleanup);
  // bb's app root wraps every plugin panel in <StrictMode>, whose dev
  // double mount runs the boundary's cleanup and re-mount BEFORE the
  // queued sweep microtask — the sweep must then leave the reclaimed
  // client alone or it silently cancels the panel's first in-flight
  // query, freezing it on isPending. Rendered through RTL directly:
  // strict effects only fire when StrictMode is the ROOT of the render
  // (nested under providers, as renderSlot mounts things, React 19 only
  // double-RENDERS), so renderSlot cannot reproduce this. The response
  // resolves on a timer so it lands after the sweep, like real HTTP.
  function StrictPanel() {
    const strict = useTanStackQuery({
      queryKey: ["strict-mount"],
      queryFn: () => new Promise((resolve) => setTimeout(() => resolve("ok"), 20)),
    });
    return createElement(
      "div",
      null,
      strict.status === "success" ? `strict:${String(strict.data)}` : strict.status,
    );
  }
  render(
    createElement(
      StrictMode,
      null,
      createElement(PluginQueryBoundary, null, createElement(StrictPanel)),
    ),
  );
  await screen.findByText("strict:ok");
});

test("PluginQueryBoundary uses a provided client instead of owning one", async (t) => {
  t.after(cleanup);
  const provided = new QueryClient();
  provided.setQueryData(["demo", "overview"], { total: 42 });
  function SeededPanel() {
    const overview = rpc.overview.useQuery({ staleTime: Infinity });
    return createElement(
      "div",
      null,
      overview.status === "success" ? `total:${overview.data.total}` : overview.status,
    );
  }
  const slot = renderSlot(
    {
      component: () =>
        createElement(PluginQueryBoundary, { client: provided }, createElement(SeededPanel)),
    },
    {},
    { rpc: {} },
  );
  await slot.findByText("total:42");
  assert.equal(slot.rpcCalls.length, 0);
  slot.unmount();
  // Ownership stayed with the caller — the seeded data survives unmount.
  assert.deepEqual(provided.getQueryData(["demo", "overview"]), { total: 42 });
  // Drop the external client's gcTime timers so the process can exit.
  provided.clear();
});
