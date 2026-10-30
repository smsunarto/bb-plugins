import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type {
  Engine,
  ThreadContextInput,
  WhiteboardSettings,
} from "../../shared/contracts/engine.ts";
import { createEngine } from "../lib/engine.ts";
import {
  createInProcessHostClient,
  IN_PROCESS_HOST_ID,
  type InProcessHostClient,
} from "../lib/host-io/testing/in-process.ts";
import { files } from "../lib/instructions.ts";
import { sessionKeys } from "./catalog.ts";
import { registerTools, toolRegistry, type ToolResult } from "./registry.ts";

const settings = (scratchpadEnabled: boolean): WhiteboardSettings => ({
  scratchpadEnabled: () => scratchpadEnabled,
  softwareMapEnabled: () => true,
  subscribe: () => () => {},
});

/** An engine whose operations are `api`; `run` passes the caller's context to `onRun`. */
function stubEngine(api: object, onRun: (context: ThreadContextInput) => void = () => {}) {
  return {
    api,
    run: (context: ThreadContextInput, fn: (signal: AbortSignal) => Promise<unknown>) => {
      onRun(context);
      return fn(new AbortController().signal);
    },
  } as unknown as Engine;
}

describe("sessionKeys", () => {
  test("renames the session keys at the top level and inside session objects only", () => {
    expect(
      sessionKeys({
        reviewId: "s1",
        review: { reviewId: "s1", title: "T", document: [{ reviewId: "authored" }] },
        reviews: [{ reviewId: "s2" }],
        document: [{ reviewId: "authored", review: "authored" }],
      }),
    ).toEqual({
      sessionId: "s1",
      session: { sessionId: "s1", title: "T", document: [{ reviewId: "authored" }] },
      sessions: [{ sessionId: "s2" }],
      document: [{ reviewId: "authored", review: "authored" }],
    });
    expect(sessionKeys([{ reviewId: "s1" }, "text", null])).toEqual([
      { sessionId: "s1" },
      "text",
      null,
    ]);
  });
});

describe("invoke", () => {
  test("an unknown name, invalid input and any thrown value answer isError, never throw", async () => {
    const runs: ThreadContextInput[] = [];
    const registry = toolRegistry(
      stubEngine(
        {
          catalog: () => Promise.reject("a string, not an Error"),
        },
        (context) => runs.push(context),
      ),
      false,
    );
    expect(await registry.invoke("whiteboard_nope", {}, {})).toEqual({
      isError: true,
      content: [{ type: "text", text: "Unknown Whiteboard tool: whiteboard_nope." }],
    });
    const invalid = await registry.invoke("whiteboard_session_get", { reviewId: "s1" }, {});
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toMatch(/Unrecognized key: "reviewId"/);
    expect(invalid.content[0].text).toMatch(/sessionId/);
    expect(runs).toEqual([]);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const crashed = await registry.invoke("whiteboard_session_list", {}, { threadId: "t1" });
    expect(crashed).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Whiteboard operation failed (string). The bb server logged the cause in server-stdio.log, in the bb server's logs folder.",
        },
      ],
    });
    expect(runs).toEqual([{ threadId: "t1" }]);
  });

  test("read tools take null for an omitted field and apply the advertised defaults", async () => {
    const inspect = vi.fn(async () => "text");
    const tree = vi.fn(async () => []);
    const registry = toolRegistry(stubEngine({ inspect, tree }), false);
    await registry.invoke(
      "whiteboard_session_get",
      { sessionId: "s1", version: null, targetId: null, full: null, format: null },
      {},
    );
    expect(inspect).toHaveBeenCalledWith({
      reviewId: "s1",
      version: undefined,
      targetId: undefined,
      full: undefined,
      format: "text",
    });
    await registry.invoke("whiteboard_session_tree", { sessionId: "s1", side: null }, {});
    expect(tree).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: "s1", side: "head", path: "" }),
    );
  });
});

test("a tool bb refuses is logged and the rest still register", async () => {
  const host = createFakePluginHost({ pluginId: "whiteboard" });
  const error = vi.fn();
  const bb = {
    ...host.bb,
    log: { ...host.bb.log, error },
    agents: {
      ...host.bb.agents,
      registerTool: (tool: { name: string }) => {
        if (tool.name === "whiteboard_session_list") throw new Error("refused");
        return host.bb.agents.registerTool(tool as never);
      },
    },
  } as unknown as BbPluginApi;
  await registerTools(bb, stubEngine({}), settings(false));
  expect(error).toHaveBeenCalledWith(
    "whiteboard: whiteboard_session_list was not registered: refused",
  );
  expect(host.harness.registrations.agentTools).toHaveLength(27);
});

/**
 * The cart repository the live replay seeds: one commit adds a cart, the
 * next adds percentage discount codes. Fixed authors and dates keep the
 * commit hashes stable.
 */
function cartRepository() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "whiteboard-tools-")));
  const write = (file: string, lines: string[]) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), `${lines.join("\n")}\n`);
  };
  const commit = (message: string, date: string) => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "WB Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "WB Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  const lineItem = [
    "export interface LineItem {",
    "  sku: string;",
    "  unitPrice: number;",
    "  quantity: number;",
    "}",
    "",
  ];
  const totals = [
    "export function lineTotal(item: LineItem): number {",
    "  return item.unitPrice * item.quantity;",
    "}",
    "",
    "export function subtotal(items: LineItem[]): number {",
    "  return items.reduce((sum, item) => sum + lineTotal(item), 0);",
    "}",
  ];
  const index = (discount: string[]) => [
    'import { Cart } from "./cart";',
    "",
    "const cart = new Cart();",
    'cart.add({ sku: "apple", unitPrice: 2, quantity: 3 });',
    'cart.add({ sku: "pear", unitPrice: 5, quantity: 1 });',
    ...discount,
    "console.log(`Total: ${cart.total()}`);",
  ];

  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  write("README.md", [
    "# Cart fixture",
    "",
    "A tiny checkout library used as a Whiteboard test fixture.",
  ]);
  write("src/pricing.ts", [...lineItem, ...totals]);
  write("src/cart.ts", [
    'import { type LineItem, subtotal } from "./pricing";',
    "",
    "export class Cart {",
    "  private items: LineItem[] = [];",
    "",
    "  add(item: LineItem): void {",
    "    this.items.push(item);",
    "  }",
    "",
    "  total(): number {",
    "    return subtotal(this.items);",
    "  }",
    "}",
  ]);
  write("src/index.ts", index([]));
  const base = commit("feat: add cart and pricing", "2026-10-01T12:00:00Z");

  const applyDiscount = [
    "export function applyDiscount(amount: number, discount: Discount | null): number {",
    "  if (!discount) return amount;",
    "  const clamped = Math.min(Math.max(discount.percentOff, 0), 100);",
    "  return Math.round(amount * (100 - clamped)) / 100;",
    "}",
  ];
  write("src/pricing.ts", [
    ...lineItem,
    "export interface Discount {",
    "  code: string;",
    "  percentOff: number;",
    "}",
    "",
    ...totals,
    "",
    ...applyDiscount,
  ]);
  write("src/cart.ts", [
    'import { applyDiscount, type Discount, type LineItem, subtotal } from "./pricing";',
    "",
    "export class Cart {",
    "  private items: LineItem[] = [];",
    "  private discount: Discount | null = null;",
    "",
    "  add(item: LineItem): void {",
    "    this.items.push(item);",
    "  }",
    "",
    "  useDiscount(discount: Discount): void {",
    "    this.discount = discount;",
    "  }",
    "",
    "  total(): number {",
    "    return applyDiscount(subtotal(this.items), this.discount);",
    "  }",
    "}",
  ]);
  write("src/index.ts", index(['cart.useDiscount({ code: "FALL10", percentOff: 10 });']));
  const head = commit("feat: support percentage discount codes", "2026-10-02T12:00:00Z");
  return {
    root,
    base,
    head,
    applyDiscount,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * The live replay's seed and read calls (wb-test's seed-session.sh and
 * capture-reads.sh), run as an agent in thread t1 through bb's registration
 * against the real engine and an in-process host.
 */
describe("an agent seeds and reads a session through the tools", () => {
  let host: ReturnType<typeof createFakePluginHost>;
  let engine: Engine;
  let client: InProcessHostClient;
  let repo: ReturnType<typeof cartRepository>;
  const tabs = new Map([["t1", { revision: 0, tabs: [] as Array<Record<string, unknown>> }]]);

  const call = async (name: string, input: Record<string, unknown>) =>
    (await host.harness.callAgentTool(name, input, { threadId: "t1" })) as ToolResult;
  const text = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await call(name, input);
    if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
    return result.content[0].text;
  };
  const read = async (name: string, input: Record<string, unknown> = {}) =>
    JSON.parse(await text(name, input));

  let repositoryId: string;
  let sessionId: string;
  let created: Record<string, unknown>;
  let firstEdit: { input: Record<string, unknown>; text: string };
  const seeded: string[] = [];

  beforeAll(async () => {
    repo = cartRepository();
    host = createFakePluginHost({ pluginId: "whiteboard" });
    client = createInProcessHostClient();
    const bb = {
      ...host.bb,
      background: { ...host.bb.background, service: () => {} },
      hosts: { ...host.bb.hosts, experimental_client: () => client },
      sdk: {
        ...host.bb.sdk,
        hosts: {
          ...host.bb.sdk.hosts,
          list: async () => [
            { id: IN_PROCESS_HOST_ID, name: "Test host", type: "persistent", status: "connected" },
          ],
        },
        threads: {
          ...host.bb.sdk.threads,
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            environmentId: "e1",
          }),
          tabs: {
            get: async ({ threadId }: { threadId: string }) => structuredClone(tabs.get(threadId)),
            update: async (input: {
              threadId: string;
              tabs: Array<Record<string, unknown>>;
              expectedRevision: number;
            }) => {
              const state = tabs.get(input.threadId)!;
              state.revision++;
              state.tabs = structuredClone(input.tabs);
              return structuredClone(state);
            },
          },
        },
        environments: {
          ...host.bb.sdk.environments,
          get: async () => ({ hostId: IN_PROCESS_HOST_ID }),
        },
      },
    } as unknown as BbPluginApi;
    const on = settings(true);
    engine = createEngine(bb, on);
    await registerTools(bb, engine, on);

    repositoryId = (await read("whiteboard_session_register_repository", { path: repo.root })).id;
    const createText = await text("whiteboard_session_create", {
      source: "target",
      title: "Percentage discount codes",
      target: { kind: "commits", repositoryId, head: repo.head, base: repo.base },
      commandId: randomUUID(),
    });
    seeded.push(createText);
    created = JSON.parse(createText);
    sessionId = created.sessionId as string;

    const lease = randomUUID();
    const activity = async (action: "begin" | "end", leaseId: string, scope: string) =>
      seeded.push(
        await text("whiteboard_session_activity", {
          action,
          leaseId,
          scope,
          sessionId,
          ...(action === "begin" && {
            focus: {
              description: scope === "lenses" ? "Grouping the diff" : "Writing the walkthrough",
            },
          }),
        }),
      );
    const edit = async (tool: string, leaseId: string, change: Record<string, unknown>) => {
      const input = { sessionId, leaseId, commandId: randomUUID(), edit: change };
      const result = await text(tool, input);
      seeded.push(result);
      return { input, text: result };
    };
    const pricing = (from: number, to: number) => ({
      file: "src/pricing.ts",
      start: { side: "head", line: from },
      end: { side: "head", line: to },
    });

    await activity("begin", lease, "document");
    firstEdit = await edit("whiteboard_session_edit", lease, {
      type: "insert",
      content: {
        type: "section",
        title: "What changes",
        children: [
          {
            type: "markdown",
            markdown:
              "Carts can now take a **percentage discount code**. [`applyDiscount`](review-source:head/src/pricing.ts#L20-L24) clamps the percentage to 0-100 and rounds to cents, and [`Cart.total`](review-source:head/src/cart.ts#L15-L17) applies it to the subtotal.",
          },
        ],
      },
    });
    await edit("whiteboard_session_edit", lease, {
      type: "insert",
      content: {
        type: "section",
        title: "Design",
        children: [
          {
            type: "flow_diagram",
            title: "Computing a cart total",
            direction: "right",
            nodes: [
              {
                key: "subtotal",
                label: "Sum line totals",
                attachments: [{ label: "subtotal", sources: [pricing(16, 18)] }],
              },
              { key: "has", label: "Discount set?", kind: "decision" },
              {
                key: "clamp",
                label: "Clamp percent to 0-100",
                attachments: [{ label: "applyDiscount", sources: [pricing(20, 24)] }],
              },
              { key: "total", label: "Return total", kind: "terminal" },
            ],
            edges: [
              { from: "subtotal", to: "has" },
              { from: "has", to: "clamp", label: "yes" },
              { from: "has", to: "total", label: "no", style: "dashed" },
              { from: "clamp", to: "total" },
            ],
          },
        ],
      },
    });
    await edit("whiteboard_session_edit", lease, {
      type: "insert",
      content: {
        type: "section",
        title: "Implementation",
        children: [
          { type: "markdown", markdown: "The discount math lives in one pure function." },
          {
            type: "code_peek",
            caption: "applyDiscount clamps and rounds",
            source: pricing(20, 24),
          },
        ],
      },
    });
    await activity("end", lease, "document");

    const lenses = randomUUID();
    await activity("begin", lenses, "lenses");
    for (const [title, patterns] of [
      ["Discount pricing", ["src/pricing.ts"]],
      ["Cart wiring", ["src/cart.ts", "src/index.ts"]],
    ] as const)
      await edit("whiteboard_session_lens_edit", lenses, {
        type: "insert",
        title,
        targets: [{ kind: "files", patterns }],
      });
    await activity("end", lenses, "lenses");
  });

  afterAll(async () => {
    await engine.dispose();
    await client.simulateWorkerExit();
    await host.harness.dispose();
    repo.remove();
  });

  test("create opens the session in the calling thread and answers in the session vocabulary", () => {
    expect(created).toMatchObject({
      created: true,
      sessionId,
      version: 0,
      session: { sessionId, title: "Percentage discount codes" },
      opened: true,
      softwareMapEnabled: true,
    });
    expect(Object.keys(created)).toEqual([
      "created",
      "sessionId",
      "version",
      "session",
      "opened",
      "softwareMapEnabled",
    ]);
    expect(seeded.filter((result) => /"review(Id|s)?":/.test(result))).toEqual([]);
    expect(tabs.get("t1")!.tabs).toHaveLength(1);
  });

  test("the seed's edits answer like the live replay", () => {
    expect(JSON.parse(firstEdit.text)).toEqual({
      sessionId,
      version: 1,
      targetId: "block-1",
      type: "section",
      children: [{ id: "block-2", type: "markdown" }],
    });
    expect(seeded.slice(1).map((result) => JSON.parse(result))).toEqual([
      expect.objectContaining({ workingCount: 1, scopes: ["document"] }),
      expect.objectContaining({ version: 1 }),
      expect.objectContaining({ version: 2 }),
      expect.objectContaining({ version: 3 }),
      { workingCount: 0, expiresAt: null },
      expect.objectContaining({ workingCount: 1, scopes: ["lenses"] }),
      expect.objectContaining({ sessionId, version: 4, targetId: "lens-16", type: "lens" }),
      expect.objectContaining({ sessionId, version: 5, targetId: "lens-17", type: "lens" }),
      { workingCount: 0, expiresAt: null },
    ]);
  });

  test("retrying a command id answers the first result without a new version", async () => {
    expect(await text("whiteboard_session_edit", firstEdit.input)).toBe(firstEdit.text);
    expect(await read("whiteboard_session_history", { sessionId })).toHaveLength(6);
  });

  test("status, capabilities and list", async () => {
    expect(await read("whiteboard_status")).toMatchObject({
      key: "stable",
      channel: "bb-plugin",
      desktopAvailable: true,
    });
    expect(await read("whiteboard_session_capabilities")).toEqual({
      desktopAvailable: true,
      softwareMapEnabled: true,
      scratchpadEnabled: true,
    });
    expect(await read("whiteboard_session_list")).toContainEqual(
      expect.objectContaining({ sessionId, version: 5, title: "Percentage discount codes" }),
    );
  });

  test("get reads the document as text, in full, or as JSON", async () => {
    const outline = await text("whiteboard_session_get", { sessionId });
    expect(outline.split("\n").slice(0, 2)).toEqual([
      "# Percentage discount codes",
      `Session ${sessionId} · version 5`,
    ]);
    expect(outline).toContain(
      "Lenses (edit with whiteboard_session_lens_edit):\n[lens-16] Discount pricing\n  Files: src/pricing.ts\n[lens-17] Cart wiring\n  Files: src/cart.ts, src/index.ts",
    );
    // In full, the outline drops its closing hint about targetId and full.
    const full = await text("whiteboard_session_get", { sessionId, full: true });
    expect(outline.startsWith(full.trimEnd())).toBe(true);
    expect(outline.length).toBeGreaterThan(full.length);
    expect((await read("whiteboard_session_get", { sessionId, format: "json" }))[0]).toEqual({
      id: "block-1",
      type: "section",
      label: "What changes",
    });
    expect(
      await text("whiteboard_session_get", {
        sessionId,
        version: null,
        targetId: null,
        full: null,
        format: null,
      }),
    ).toBe(outline);
  });

  test("history, tree, diff and commits", async () => {
    expect(
      (await read("whiteboard_session_history", { sessionId })).map(
        (entry: { version: number }) => entry.version,
      ),
    ).toEqual([0, 1, 2, 3, 4, 5]);
    expect(await read("whiteboard_session_tree", { sessionId })).toEqual([
      { path: "README.md", kind: "file" },
      { path: "src", kind: "directory" },
    ]);
    expect(await read("whiteboard_session_tree", { sessionId, path: "src" })).toEqual([
      { path: "src/cart.ts", kind: "file" },
      { path: "src/index.ts", kind: "file" },
      { path: "src/pricing.ts", kind: "file" },
    ]);
    const changed = [
      { path: "src/cart.ts", status: "modified", additions: 7, deletions: 2 },
      { path: "src/index.ts", status: "modified", additions: 1, deletions: 0 },
      { path: "src/pricing.ts", status: "modified", additions: 11, deletions: 0 },
    ];
    expect(await read("whiteboard_session_diff", { sessionId })).toEqual(changed);
    expect(await read("whiteboard_session_diff", { sessionId, format: "files" })).toEqual(changed);
    expect(
      await read("whiteboard_session_diff", { sessionId, paths: null, context: null, file: null }),
    ).toEqual(changed);
    const patch = await text("whiteboard_session_diff", { sessionId, format: "patch" });
    expect(patch.split("\n").slice(0, 2)).toEqual([
      "diff --git a/src/cart.ts b/src/cart.ts",
      "@@ -1,13 +1,18 @@",
    ]);
    expect(await read("whiteboard_session_commits", { sessionId })).toEqual([
      {
        commit: repo.head,
        parentCommit: repo.base,
        subject: "feat: support percentage discount codes",
        author: "WB Fixture",
        authoredAt: "2026-10-02T12:00:00Z",
        fileCount: 3,
        additions: 19,
        deletions: 2,
      },
    ]);
  });

  test("file and source read the pinned commits", async () => {
    const head = await read("whiteboard_session_file", {
      sessionId,
      side: "head",
      file: "src/pricing.ts",
    });
    expect(head).toMatchObject({ file: "src/pricing.ts", side: "head", commit: repo.head });
    expect(head.text).toContain(repo.applyDiscount.join("\n"));
    expect(
      await read("whiteboard_session_file", { sessionId, side: "base", file: "src/pricing.ts" }),
    ).toMatchObject({ side: "base", commit: repo.base });
    expect(
      await read("whiteboard_session_source", {
        sessionId,
        source: { side: "head", file: "src/pricing.ts", fromLine: 20, toLine: 24 },
      }),
    ).toEqual({
      side: "head",
      file: "src/pricing.ts",
      fromLine: 20,
      toLine: 24,
      commit: repo.head,
      text: repo.applyDiscount.join("\n"),
    });
  });

  test("get_instructions answers each topic as plain text", async () => {
    const authoring = await text("whiteboard_session_get_instructions");
    expect(authoring.startsWith(files.read("authoring"))).toBe(true);
    expect(authoring).toContain(
      '- Explaining code visually outside a review: `whiteboard_session_get_instructions({topic:"scratchpad"})`',
    );
    expect(await text("whiteboard_session_get_instructions", { topic: null })).toBe(authoring);
    expect(await text("whiteboard_session_get_instructions", { topic: "file-lenses" })).toBe(
      files.read("file-lenses"),
    );
    expect(await text("whiteboard_session_get_instructions", { topic: "scratchpad" })).toBe(
      files.read("scratchpad"),
    );
  });

  test("failures answer isError with the operation's message", async () => {
    const edit = await call("whiteboard_session_edit", {
      reviewId: sessionId,
      commandId: randomUUID(),
      edit: { type: "insert", content: { type: "markdown", markdown: "x" } },
    });
    expect(edit.isError).toBe(true);
    expect(edit.content[0].text).toMatch(/Unrecognized key: "reviewId"/);

    expect(await call("whiteboard_session_get", { sessionId: "nope" })).toEqual({
      isError: true,
      content: [{ type: "text", text: "Whiteboard or version not found." }],
    });

    const noLease = await call("whiteboard_session_lens_edit", {
      sessionId,
      leaseId: randomUUID(),
      commandId: randomUUID(),
      edit: { type: "remove", targetId: "lens-16" },
    });
    expect(noLease.isError).toBe(true);
    expect(noLease.content[0].text).toContain(
      'Begin one with whiteboard_session_activity scope:"lenses"',
    );
  });
});
