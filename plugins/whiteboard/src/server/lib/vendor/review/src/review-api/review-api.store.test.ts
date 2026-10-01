// Vendored from dev.fast review/src/review-api/review-api.test.ts lines 1-11,14-18,20-1737 @4ecc570 (MIT).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "../../../../sqlite-testing.ts";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { selectSource } from "../../../../../../shared/vendor/review/src/lens-selection.ts";
import { type AuthoringTool, callAuthoringTool } from "./agent-client.ts";
import { authoringTools } from "./authoring-tools.ts";
import { ReviewApiClient } from "../../../../../../shared/vendor/review/src/review-api/client.ts";
import { documentText } from "../../../../../../shared/vendor/review/src/review-api/document-text.ts";
import { ReviewInputError } from "../../../../../../shared/vendor/review/src/review-api/document.ts";
import {
  type ReviewProviders,
  ReviewStore,
  SCRATCHPAD_ID,
  inspectSnapshot,
} from "./store.ts";

const pins = { repositoryId: "repo", base: "base-commit", head: "head-commit" };

const source = {
  side: "head" as const,
  file: "src/store.ts",
  fromLine: 1,
  toLine: 5,
};

const diagram = {
  type: "sequence",
  title: "Save",
  actors: { app: "App", db: "Database" },
  steps: [
    { from: "app", to: "db", label: "Write", source: selectSource(source) },
  ],
};

let directory: string, database: string, store: ReviewStore;

let providers: ReviewProviders;

const request = <Operation>(operation: Operation) => ({
  commandId: randomUUID(),
  operation,
});

const create = () =>
  store.execute(request({ type: "create", title: "Example", pins }));

const edit = <Content>(reviewId: string, value: Content) =>
  store.execute(request({ type: "edit", reviewId, edit: value }));

const writeLens = <Edit>(reviewId: string, value: Edit, leaseId?: string) =>
  store.execute({
    ...request({ type: "lens", reviewId, edit: value }),
    leaseId,
  });

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "review-lean-"));
  database = path.join(directory, "reviews.db");
  vi.stubEnv("DEV_REVIEW_HOME", directory);
  providers = {
    validatePins: vi.fn<ReviewProviders["validatePins"]>(async () => {}),
    validateSource: vi.fn<ReviewProviders["validateSource"]>(async () => {}),
    validateResource: vi.fn<ReviewProviders["validateResource"]>(
      async () => {},
    ),
  };
  store = new ReviewStore(database, providers);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("snapshot authoring", () => {
  it("binds PR identity without erasing content, versions changes, and clears stale identity across repositories", async () => {
    const url = "https://github.com/devdotfast/review/pull/310";

    const { reviewId } = await store.execute(
      request({
        type: "create",
        title: "PR review",
        pins,
        pullRequestUrl: url,
      }),
    );

    expect(store.list()[0]?.origin).toEqual({
      pullRequestNumber: 310,
      pullRequestUrl: url,
    });
    await edit(reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Keep this analysis" },
    });
    const authored = store.read(reviewId);

    const rebinding = request({
      type: "repin",
      pins,
      reviewId,
      pullRequestUrl: "https://github.com/devdotfast/review/pull/311",
    });

    const bound = await store.execute(rebinding);
    expect(await store.execute(rebinding)).toEqual(bound);
    expect(store.read(reviewId).document).toEqual(authored.document);
    expect(store.read(reviewId).pins).toEqual(pins);
    expect(store.read(reviewId).origin?.pullRequestNumber).toBe(311);
    expect(
      store.read(reviewId, authored.version).origin?.pullRequestNumber,
    ).toBe(310);
    await store.execute(
      request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }),
    );
    expect(store.read(reviewId).origin?.pullRequestNumber).toBe(311);
    await store.execute(
      request({
        type: "repin",
        reviewId,
        pins: { ...pins, repositoryId: "other-repository" },
      }),
    );
    expect(store.read(reviewId).origin?.pullRequestUrl).toBeUndefined();
    await store.execute(
      request({ type: "restore", reviewId, version: authored.version }),
    );
    expect(store.read(reviewId).origin?.pullRequestNumber).toBe(310);
    expect(store.read(reviewId).document).toEqual(authored.document);
    await store.execute(
      request({ type: "repin", reviewId, pins, pullRequestUrl: null }),
    );
    expect(store.read(reviewId).origin?.pullRequestNumber).toBeUndefined();
    expect(store.read(reviewId).document).toEqual(authored.document);
  });

  it("preserves imported provenance when attaching a PR and supports explicit repin identity", async () => {
    const { reviewId } = await create();
    await store.importVersion({
      reviewId,
      title: "Imported",
      pins,
      document: [],
      createdAt: new Date().toISOString(),
      origin: {
        branch: "feature",
        baseRef: "main",
        revision: "legacy-revision",
      },
    });
    await store.execute(
      request({
        type: "repin",
        reviewId,
        pins,
        pullRequestUrl: "https://github.com/devdotfast/review/pull/319",
      }),
    );
    expect(store.read(reviewId).origin).toEqual({
      branch: "feature",
      baseRef: "main",
      revision: "legacy-revision",
      pullRequestNumber: 319,
      pullRequestUrl: "https://github.com/devdotfast/review/pull/319",
    });
    await store.execute(
      request({ type: "repin", reviewId, pins, pullRequestUrl: null }),
    );
    expect(store.read(reviewId).origin).toEqual({
      branch: "feature",
      baseRef: "main",
      revision: "legacy-revision",
    });
  });

  it.each([
    "javascript:alert(1)",
    "https://github.com/owner/repo/issues/1",
    "https://github.com/owner/repo/pull/0",
    "https://github.com/owner/repo/pull/999999999999999999999",
    "https://github.com/owner/repo/pull/1#discussion",
  ])("rejects invalid PR identity %s before writing", async (url) => {
    expect(() =>
      store.execute(
        request({
          type: "create",
          title: "Bad identity",
          pins,
          pullRequestUrl: url,
        }),
      ),
    ).toThrow(/canonical GitHub PR URL|PR number is too large/);
    expect(store.list()).toEqual([]);
  });

  it("compares execution paths in the same snapshot without changing their source pins", async () => {
    const { reviewId } = await create();
    await edit(reviewId, {
      type: "insert",
      content: {
        type: "call_stack_diff",
        title: "Mouse versus keyboard",
        base: [
          {
            key: "mouse",
            label: "selectionchange",
            source: selectSource(source),
          },
        ],
        head: [
          { key: "keyboard", label: "keydown", source: selectSource(source) },
        ],
      },
    });
    const saved = store.read(reviewId).document[0]!;
    expect(saved).toMatchObject({
      type: "call_stack_diff",
      base: [{ source: selectSource(source) }],
      head: [{ source: selectSource(source) }],
    });
    expect(providers.validateSource).toHaveBeenCalledWith(pins, source, {
      peek: true,
    });
  });

  it("deletes one review and its history, keeps other reviews, and cannot replay deleted content", async () => {
    const input = request({ type: "create", title: "Delete me", pins });
    const { reviewId } = await store.execute(input);
    const other = await create();
    await edit(reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Private review text" },
    });
    const deletion = request({ type: "delete", reviewId });
    const result = await store.execute(deletion);
    expect(result).toMatchObject({ reviewId, deleted: true });
    expect(await store.execute(deletion)).toEqual(result);
    expect(() => store.read(reviewId)).toThrow(/not found/);
    expect(store.history(reviewId)).toEqual([]);
    expect(store.read(other.reviewId)).toMatchObject({
      version: 0,
      title: "Example",
    });
    await store.close();
    store = new ReviewStore(database, providers);
    expect(store.list().map((review) => review.reviewId)).toEqual([
      other.reviewId,
    ]);
    await expect(store.execute(input)).rejects.toThrow(/was deleted/);
    expect(await store.execute(deletion)).toEqual(result);
  });
  it("persists attention without creating a document version or notifying its readers", async () => {
    const { reviewId } = await create();
    const other = await create();
    const document = store.read(reviewId);

    const documents = vi.fn<Parameters<ReviewStore["subscribe"]>[0]>(),
      catalog = vi.fn<() => void>();

    store.subscribe(documents);
    store.subscribeCatalog(catalog);
    const dismiss = request({ type: "attention", reviewId, action: "dismiss" });
    const result = await store.execute(dismiss);
    await store.execute(dismiss);
    await store.execute(
      request({ type: "attention", reviewId, action: "view" }),
    );
    expect(result).toMatchObject({ version: 0, attention: true });
    expect(documents).not.toHaveBeenCalled();
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(store.read(reviewId)).toEqual(document);
    expect(store.history(reviewId)).toHaveLength(1);
    await store.close();
    store = new ReviewStore(database, providers);
    expect(
      store.list().find((review) => review.reviewId === reviewId),
    ).toMatchObject({
      viewedAt: expect.any(String),
      dismissedAt: expect.any(String),
    });
    expect(
      store.list().find((review) => review.reviewId === other.reviewId),
    ).toMatchObject({
      viewedAt: null,
      dismissedAt: null,
    });
    await store.execute(
      request({ type: "attention", reviewId, action: "restore" }),
    );
    expect(
      store.list().find((review) => review.reviewId === reviewId)?.dismissedAt,
    ).toBeNull();
  });

  it.each([
    { type: "markdown", markdown: "# Summary\n**Ordinary Markdown**" },
    { type: "code", language: "ts", text: "const value = 1" },
    { type: "divider" },
    {
      type: "section",
      title: "Details",
      children: [{ type: "markdown", markdown: "Nested" }],
    },
    { type: "callout", tone: "warning", children: [] },
    { type: "code_peek", source: selectSource(source) },
    diagram,
    {
      type: "call_stack_diff",
      title: "Change",
      base: [{ source: selectSource({ ...source, side: "base" }) }],
      head: [{ source: selectSource(source) }],
    },
    {
      type: "database_lens",
      title: "Storage",
      actors: { app: "App" },
      stores: {
        db: {
          label: "Database",
          storage: "relational",
          collections: {
            reviews: {
              label: "Reviews",
              fields: { id: { label: "ID", dataType: "text" } },
            },
          },
        },
      },
      useCases: [
        {
          label: "Save",
          operations: [
            {
              kind: "write",
              store: "db",
              collection: "reviews",
              actor: "app",
              label: "Insert",
              source: selectSource(source),
            },
          ],
        },
      ],
    },
    { type: "image", assetId: "image-1", alt: "Example" },
    {
      type: "trace_quote",
      traceId: "trace-1",
      eventId: "event-1",
      text: "Keep it simple",
    },
    { type: "software_map", mapVersionId: "map-1" },
  ])(
    "saves and reads a $type component without a second document representation",
    async (content) => {
      const { reviewId } = await create();
      const result = await edit(reviewId, { type: "insert", content });
      expect(store.inspect(reviewId, result.targetId)).toMatchObject({
        ...content,
        id: result.targetId,
      });
      expect(store.inspect(reviewId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: result.targetId, type: content.type }),
        ]),
      );
    },
  );

  it("keeps reviews isolated and history readable across restart, deletion, restore and new pins", async () => {
    const first = await create(),
      second = await create();

    const inserted = await edit(first.reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Keep history" },
    });

    await edit(first.reviewId, { type: "remove", targetId: inserted.targetId });
    await store.close();
    store = new ReviewStore(database, providers);
    expect(store.read(first.reviewId).document).toEqual([]);
    expect(
      store.read(first.reviewId, inserted.version).document[0],
    ).toMatchObject({ id: inserted.targetId, markdown: "Keep history" });
    await store.execute(
      request({
        type: "restore",
        reviewId: first.reviewId,
        version: inserted.version,
      }),
    );

    const next = await edit(first.reviewId, {
      type: "insert",
      content: { type: "divider" },
    });

    expect(next.targetId).not.toBe(inserted.targetId);
    const beforeRepin = store.read(first.reviewId);
    await store.execute(
      request({
        type: "repin",
        reviewId: first.reviewId,
        pins: { ...pins, head: "new-head" },
      }),
    );
    expect(store.read(first.reviewId)).toMatchObject({
      document: beforeRepin.document,
      pins: { head: "new-head" },
    });
    expect(store.read(second.reviewId)).toMatchObject({
      document: [],
      version: 0,
      pins,
    });
    expect(store.list()).toHaveLength(2);
  });

  it("retains stale references on repin, reports them, and allows incremental repairs", async () => {
    const { reviewId } = await create();
    await edit(reviewId, {
      type: "insert",
      content: { type: "code_peek", source: selectSource(source) },
    });
    await edit(reviewId, {
      type: "insert",
      content: { type: "software_map", mapVersionId: "map" },
    });
    const original = store.read(reviewId);
    vi.mocked(providers.validateSource).mockRejectedValue(
      new ReviewInputError("File is unavailable at the pinned commit.", 404),
    );
    vi.mocked(providers.validateResource).mockRejectedValue(
      new ReviewInputError("Map does not match this review's source pins."),
    );

    const command = request({
      type: "repin",
      reviewId,
      pins: { ...pins, head: "new-head" },
    });

    const result = await store.execute(command);

    expect(result.warnings).toEqual([
      "block-2 (software_map): Map does not match this review's source pins.",
      "head/src/store.ts#L1-L5: File is unavailable at the pinned commit.",
    ]);
    expect(await store.execute(command)).toEqual(result);
    expect(store.read(reviewId).document).toEqual(original.document);
    expect(store.read(reviewId, original.version)).toEqual(original);
    await edit(reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Working on the update" },
    });
    vi.mocked(providers.validateSource).mockResolvedValue();
    await edit(reviewId, {
      type: "update",
      targetId: original.document[0]!.id!,
      changes: { source: selectSource({ ...source, file: "renamed.ts" }) },
    });
    expect(store.read(reviewId).document[0]).toMatchObject({
      id: original.document[0]!.id,
      source: { file: "renamed.ts" },
    });
  });

  it("asks agents to verify retained ranges even when their line numbers remain valid", async () => {
    const { reviewId } = await create();
    await edit(reviewId, {
      type: "insert",
      content: { type: "code_peek", source: selectSource(source) },
    });

    const result = await store.execute(
      request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }),
    );

    expect(result.warnings).toEqual([
      "head/src/store.ts#L1-L5: source pins changed; verify that this range still supports the document.",
    ]);

    const samePins = await store.execute(
      request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }),
    );

    expect(samePins.warnings).toBeUndefined();
  });

  it("does not save a repin when pin resolution or source infrastructure fails", async () => {
    const { reviewId } = await create();
    await edit(reviewId, {
      type: "insert",
      content: { type: "code_peek", source: selectSource(source) },
    });
    const original = store.read(reviewId);
    vi.mocked(providers.validatePins).mockRejectedValueOnce(
      new ReviewInputError("Missing commit"),
    );
    await expect(
      store.execute(
        request({
          type: "repin",
          reviewId,
          pins: { ...pins, head: "missing" },
        }),
      ),
    ).rejects.toThrow("Missing commit");
    vi.mocked(providers.validateSource).mockRejectedValueOnce(
      new Error("Repository read failed"),
    );
    await expect(
      store.execute(
        request({
          type: "repin",
          reviewId,
          pins: { ...pins, head: "new-head" },
        }),
      ),
    ).rejects.toThrow("Repository read failed");
    expect(store.read(reviewId)).toEqual(original);
  });

  it("patches and reorders individual steps, and replacement gives descendants new IDs", async () => {
    const { reviewId } = await create();

    const { targetId } = await edit(reviewId, {
      type: "insert",
      content: diagram,
    });

    const value = () => {
      const block = store.read(reviewId).document[0]!;

      if (block.type !== "sequence") throw new Error("Expected sequence");

      return block;
    };

    const step = value().steps[0]!.id;

    const second = await edit(reviewId, {
      type: "insert",
      parentId: targetId,
      afterId: step,
      content: {
        type: "step",
        from: "db",
        to: "app",
        label: "Reply",
        explanation: "Saved",
      },
    });

    await edit(reviewId, {
      type: "update",
      targetId: step,
      changes: { label: "Commit" },
    });
    expect(value().steps[0]).toMatchObject({
      id: step,
      label: "Commit",
      source: selectSource(source),
    });
    expect(providers.validateSource).toHaveBeenCalledTimes(1);
    await edit(reviewId, {
      type: "move",
      targetId: step,
      parentId: targetId,
      afterId: second.targetId,
    });
    expect(value().steps.map((s) => s.id)).toEqual([second.targetId, step]);
    await edit(reviewId, { type: "replace", targetId, content: diagram });
    expect(value().id).toBe(targetId);
    expect(value().steps[0]!.id).not.toBe(step);
    await expect(
      edit(reviewId, { type: "remove", targetId: step }),
    ).rejects.toThrow(/does not exist/);
  });

  it("names what an insert or replace wrote: the target's type and its first-level children", async () => {
    const { reviewId } = await create();

    const section = await edit(reviewId, {
      type: "insert",
      content: {
        type: "section",
        title: "Design",
        children: [
          { type: "markdown", markdown: "First" },
          {
            type: "callout",
            tone: "info",
            children: [{ type: "markdown", markdown: "Nested" }],
          },
          { type: "markdown", markdown: "Last" },
        ],
      },
    });

    const saved = () => {
      const block = store.read(reviewId).document[0]!;

      if (block.type !== "section") throw new Error("Expected section");

      return block;
    };

    const listed = () =>
      saved().children.map(({ id, type }) => ({ id: id!, type }));

    // Grandchildren inside the callout are one read away, not listed here.
    expect(section).toMatchObject({
      targetId: saved().id,
      type: "section",
      children: listed(),
    });
    expect(section.children?.map((child) => child.type)).toEqual([
      "markdown",
      "callout",
      "markdown",
    ]);

    const leaf = await edit(reviewId, {
      type: "insert",
      parentId: section.targetId,
      content: { type: "markdown", markdown: "Leaf" },
    });

    expect(leaf.type).toBe("markdown");
    expect(leaf).not.toHaveProperty("children");

    const replaced = await edit(reviewId, {
      type: "replace",
      targetId: section.targetId,
      content: {
        type: "section",
        title: "Design",
        children: [
          { type: "markdown", markdown: "Fresh" },
          { type: "markdown", markdown: "Fresher" },
        ],
      },
    });

    expect(replaced).toMatchObject({
      targetId: section.targetId,
      type: "section",
      children: listed(),
    });
    expect(
      replaced.children?.some((child) =>
        section.children?.some((old) => old.id === child.id),
      ),
    ).toBe(false);

    const updated = await edit(reviewId, {
      type: "update",
      targetId: replaced.children![0]!.id,
      changes: { markdown: "Still a leaf" },
    });

    expect(updated.type).toBe("markdown");
    expect(updated).not.toHaveProperty("children");
  });

  it("lists a diagram's units as its children: steps, or nodes then edges", async () => {
    const { reviewId } = await create();

    const flow = await edit(reviewId, {
      type: "insert",
      content: {
        type: "flow_diagram",
        title: "Lease",
        nodes: [
          { key: "a", label: "A", attachments: [] },
          { key: "b", label: "B", attachments: [] },
        ],
        edges: [{ from: "a", to: "b" }],
      },
    });

    const block = store.read(reviewId).document[0]!;

    if (block.type !== "flow_diagram") throw new Error("Expected flow");
    expect(flow).toMatchObject({
      type: "flow_diagram",
      children: [
        { id: block.nodes[0]!.id, type: "flow_node" },
        { id: block.nodes[1]!.id, type: "flow_node" },
        { id: block.edges[0]!.id, type: "flow_edge" },
      ],
    });

    const sequence = await edit(reviewId, { type: "insert", content: diagram });

    const steps = store.read(reviewId).document[1]!;

    if (steps.type !== "sequence") throw new Error("Expected sequence");
    expect(sequence).toMatchObject({
      type: "sequence",
      children: steps.steps.map((step) => ({ id: step.id, type: "step" })),
    });
  });

  it("lists a whole diagram's units in drawing order: each edge once both ends are drawn", async () => {
    const { reviewId } = await create();

    const { targetId } = await edit(reviewId, {
      type: "insert",
      content: {
        type: "flow_diagram",
        title: "Lease",
        nodes: [
          { key: "a", label: "A", attachments: [] },
          { key: "b", label: "B", attachments: [] },
          { key: "c", label: "C", attachments: [] },
        ],
        edges: [
          { from: "a", to: "c" },
          { from: "a", to: "b" },
          { from: "c", to: "b" },
        ],
      },
    });

    const block = store.read(reviewId).document[0]!;

    if (block.type !== "flow_diagram") throw new Error("Expected flow");
    const [a, b, c] = block.nodes.map((node) => node.id);
    const [ac, ab, cb] = block.edges.map((edge) => edge.id);
    expect(store.read(reviewId).lastEdit).toMatchObject({
      type: "insert",
      targetId,
      units: [a, b, ab, c, ac, cb],
    });

    const sequence = await edit(reviewId, {
      type: "replace",
      targetId,
      content: {
        type: "sequence",
        title: "Renewal",
        actors: { agent: "Agent", server: "Server" },
        steps: [
          {
            from: "agent",
            to: "server",
            label: "renew",
            style: "call",
            explanation: "Fresh expiry.",
          },
          {
            from: "server",
            to: "agent",
            label: "ok",
            style: "return",
            explanation: "Renewed.",
          },
        ],
      },
    });

    const replaced = store.read(reviewId).document[0]!;

    if (replaced.type !== "sequence") throw new Error("Expected sequence");
    expect(store.read(reviewId).lastEdit).toMatchObject({
      type: "replace",
      targetId: sequence.targetId,
      units: replaced.steps.map((step) => step.id),
    });
  });

  it("draws a flow diagram one node and edge at a time, and a removed node takes its edges", async () => {
    const { reviewId } = await create();

    const { targetId: diagramId } = await edit(reviewId, {
      type: "insert",
      content: {
        type: "flow_diagram",
        title: "Lease",
        nodes: [{ key: "session", label: "Session svc", attachments: [] }],
        edges: [],
      },
    });

    const value = () => {
      const block = store.read(reviewId).document[0]!;

      if (block.type !== "flow_diagram") throw new Error("Expected flow");

      return block;
    };

    const session = value().nodes[0]!.id!;
    expect(session).toMatch(/^node-/);
    expect(store.read(reviewId).lastEdit).toEqual({
      type: "insert",
      targetId: diagramId,
      blockId: diagramId,
      kind: "flow_diagram",
      units: [session],
    });

    const broker = await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: {
        type: "flow_node",
        key: "broker",
        label: "Lease broker",
        attachments: [],
      },
    });

    const supervisor = await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      afterId: session,
      content: {
        type: "flow_node",
        key: "sup",
        label: "Runtime sup",
        attachments: [],
      },
    });

    expect(value().nodes.map((node) => node.key)).toEqual([
      "session",
      "sup",
      "broker",
    ]);

    const acquires = await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: {
        type: "flow_edge",
        from: "session",
        to: "broker",
        label: "acquires",
      },
    });

    expect(acquires.targetId).toMatch(/^edge-/);
    expect(store.read(reviewId).lastEdit).toEqual({
      type: "insert",
      targetId: acquires.targetId,
      blockId: diagramId,
      kind: "flow_edge",
      unit: "flow_edge",
    });

    await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: { type: "flow_edge", from: "broker", to: "sup" },
    });

    await edit(reviewId, {
      type: "update",
      targetId: broker.targetId,
      changes: { label: "Broker", kind: "decision" },
    });
    expect(value().nodes[2]).toMatchObject({
      id: broker.targetId,
      type: "flow_node",
      key: "broker",
      label: "Broker",
      kind: "decision",
    });
    expect(store.read(reviewId).lastEdit).toMatchObject({
      type: "update",
      kind: "flow_node",
      fields: ["label", "kind"],
    });

    await edit(reviewId, {
      type: "update",
      targetId: acquires.targetId,
      changes: { label: "acquires a lease" },
    });
    expect(value().edges[0]).toMatchObject({ label: "acquires a lease" });

    // The outline and a targeted read see the units.
    expect(
      inspectSnapshot(store.read(reviewId), broker.targetId),
    ).toMatchObject({ type: "flow_node", key: "broker" });
    const outline = inspectSnapshot(store.read(reviewId));
    expect(
      Array.isArray(outline) ? outline.map((entry) => entry.type) : outline,
    ).toEqual([
      "flow_diagram",
      "flow_node",
      "flow_node",
      "flow_node",
      "flow_edge",
      "flow_edge",
    ]);

    await edit(reviewId, {
      type: "move",
      targetId: broker.targetId,
      parentId: diagramId,
      afterId: session,
    });
    expect(value().nodes.map((node) => node.key)).toEqual([
      "session",
      "broker",
      "sup",
    ]);

    await expect(
      edit(reviewId, {
        type: "replace",
        targetId: broker.targetId,
        content: { type: "divider" },
      }),
    ).rejects.toThrow(/Patch the flow_node/);
    await expect(
      edit(reviewId, {
        type: "insert",
        content: {
          type: "flow_node",
          key: "loose",
          label: "Loose",
          attachments: [],
        },
      }),
    ).rejects.toThrow(/belongs inside a flow_diagram/);
    await expect(
      edit(reviewId, {
        type: "insert",
        parentId: diagramId,
        content: { type: "flow_edge", from: "session", to: "missing" },
      }),
    ).rejects.toThrow(/Unknown flow endpoint/);

    await edit(reviewId, { type: "remove", targetId: broker.targetId });
    expect(value().nodes.map((node) => node.key)).toEqual(["session", "sup"]);
    expect(value().edges).toEqual([]);
    expect(supervisor.targetId).toMatch(/^node-/);

    // A removed unit is still attributed to its diagram; a rename is not an edit.
    expect(store.read(reviewId).lastEdit).toEqual({
      type: "remove",
      targetId: broker.targetId,
      blockId: diagramId,
      kind: "flow_node",
      unit: "flow_node",
    });
    await store.execute(request({ type: "rename", reviewId, title: "Leases" }));
    expect(store.read(reviewId).lastEdit).toBeUndefined();

    // A node can arrive with the edge that attaches it, in one version.
    const sweeper = await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: {
        type: "flow_node",
        key: "sweeper",
        label: "Sweeper",
        attachments: [],
        link: { from: "sup", label: "expires", style: "dashed" },
      },
    });

    expect(value().nodes.at(-1)).toMatchObject({
      id: sweeper.targetId,
      key: "sweeper",
    });
    expect(value().nodes.at(-1)).not.toHaveProperty("link");
    expect(value().edges).toMatchObject([
      { from: "sup", to: "sweeper", label: "expires", style: "dashed" },
    ]);
    expect(store.read(reviewId).lastEdit).toEqual({
      type: "insert",
      targetId: sweeper.targetId,
      blockId: diagramId,
      kind: "flow_node",
      unit: "flow_node",
      linkId: value().edges[0]!.id,
    });
    await expect(
      edit(reviewId, {
        type: "insert",
        parentId: diagramId,
        content: {
          type: "flow_node",
          key: "both",
          label: "Both",
          attachments: [],
          link: { from: "sup", to: "sweeper" },
        },
      }),
    ).rejects.toThrow(/exactly one of from or to/);
    await expect(
      edit(reviewId, {
        type: "update",
        targetId: sweeper.targetId,
        changes: { link: { from: "session" } },
      }),
    ).rejects.toThrow(/only comes with a new node/);
  });

  it("accepts flow nodes with no code attachments and reads them back with an empty list", async () => {
    const { reviewId } = await create();

    const evidence = [{ label: "Entry", sources: [selectSource(source)] }];

    const { targetId: diagramId } = await edit(reviewId, {
      type: "insert",
      content: {
        type: "flow_diagram",
        title: "CLI",
        nodes: [
          { key: "run", label: "Run", attachments: evidence },
          { key: "ok", label: "exit 0", kind: "terminal" },
        ],
        edges: [{ from: "run", to: "ok" }],
      },
    });

    await edit(reviewId, {
      type: "insert",
      parentId: diagramId,
      content: {
        type: "flow_node",
        key: "fail",
        label: "exit 1",
        kind: "terminal",
        link: { from: "run" },
      },
    });

    const block = store.read(reviewId).document[0]!;

    if (block.type !== "flow_diagram") throw new Error("Expected flow");
    expect(
      block.nodes.map(({ key, attachments }) => ({ key, attachments })),
    ).toEqual([
      { key: "run", attachments: evidence },
      { key: "ok", attachments: [] },
      { key: "fail", attachments: [] },
    ]);

    // The published tool schema does not tell agents attachments are required.
    const nodeSchemas = (
      schema: z.core.JSONSchema._JSONSchema,
    ): z.core.JSONSchema.JSONSchema[] =>
      schema === true || schema === false
        ? []
        : [
            ...(schema.properties?.key && schema.properties.attachments
              ? [schema]
              : []),
            ...[
              ...Object.values(schema.properties ?? {}),
              ...(schema.anyOf ?? []),
              ...(schema.oneOf ?? []),
              ...[schema.items ?? []].flat(),
            ].flatMap(nodeSchemas),
          ];

    const published = nodeSchemas(
      authoringTools().find((tool) => tool.name === "review_edit")!.inputSchema,
    );

    expect(published.length).toBeGreaterThan(0);

    for (const schema of published)
      expect(schema.required).not.toContain("attachments");
  });

  it("moves blocks in both directions and between containers without duplicating them", async () => {
    const { reviewId } = await create();

    const insert = <Content>(content: Content) =>
      edit(reviewId, { type: "insert", content });

    const a = (await insert({ type: "divider" })).targetId,
      b = (await insert({ type: "divider" })).targetId;

    const c = (
      await insert({ type: "section", title: "Container", children: [] })
    ).targetId;

    await edit(reviewId, { type: "move", targetId: c, afterId: a });
    expect(store.read(reviewId).document.map((b) => b.id)).toEqual([a, c, b]);
    await edit(reviewId, { type: "move", targetId: a, afterId: b });
    expect(store.read(reviewId).document.map((b) => b.id)).toEqual([c, b, a]);
    await edit(reviewId, { type: "move", targetId: a, parentId: c });
    expect(store.read(reviewId).document).toMatchObject([
      { id: c, children: [{ id: a }] },
      { id: b },
    ]);
    await expect(
      edit(reviewId, { type: "move", targetId: c, parentId: a }),
    ).rejects.toThrow(Error);
  });

  it("does not save any part of an invalid edit or failed external check", async () => {
    const { reviewId } = await create();
    const before = store.read(reviewId);

    const invalid = [
      { type: "insert", afterId: "missing", content: { type: "divider" } },
      { type: "insert", content: { ...diagram, actors: {} } },
      {
        type: "insert",
        content: { type: "markdown", id: "client-id", markdown: "No" },
      },
      {
        type: "insert",
        content: {
          type: "code_peek",
          source: selectSource({ ...source, fromLine: 10 }),
        },
      },
    ];

    for (const op of invalid)
      await expect(async () => edit(reviewId, op)).rejects.toThrow(Error);
    providers.validateSource = async () => {
      throw new ReviewInputError("Range does not exist.");
    };

    await expect(
      edit(reviewId, {
        type: "insert",
        content: { type: "code_peek", source: selectSource(source) },
      }),
    ).rejects.toThrow(/Range/);
    expect(store.read(reviewId)).toEqual(before);
    expect(store.history(reviewId).map((item) => item.version)).toEqual([0]);
    expect(
      (await edit(reviewId, { type: "insert", content: { type: "divider" } }))
        .targetId,
    ).toBe("block-1");
  });

  it("rejects whitespace-only ranges wherever they render as a peek", async () => {
    const { reviewId } = await create();
    const before = store.read(reviewId);
    const calls: boolean[] = [];

    providers.validateSource = async (_pins, _source, options) => {
      calls.push(options.peek);

      if (options.peek)
        throw new ReviewInputError(
          "Source range src/store.ts:1-5 contains only whitespace.",
        );
    };

    const peekInserts = [
      {
        type: "sequence",
        title: "Save",
        actors: { a: "App", s: "Server" },
        steps: [
          { from: "a", to: "s", label: "save", source: selectSource(source) },
        ],
      },
      {
        type: "call_stack_diff",
        title: "Save path",
        base: [],
        head: [{ key: "save", label: "save", source: selectSource(source) }],
      },
      {
        type: "database_lens",
        title: "Saves",
        actors: { s: "Server" },
        stores: {
          db: {
            label: "DB",
            storage: "relational",
            collections: {
              saves: {
                label: "Saves",
                fields: { id: { label: "id", dataType: "text" } },
              },
            },
          },
        },
        useCases: [
          {
            label: "Save",
            operations: [
              {
                kind: "write",
                store: "db",
                collection: "saves",
                actor: "s",
                label: "insert",
                source: selectSource(source),
              },
            ],
          },
        ],
      },
    ];

    for (const content of peekInserts)
      await expect(edit(reviewId, { type: "insert", content })).rejects.toThrow(
        /contains only whitespace/,
      );

    expect(store.read(reviewId)).toEqual(before);

    const link = await edit(reviewId, {
      type: "insert",
      content: {
        type: "markdown",
        markdown: `[save](review-source:${source.side}/${source.file}#L${source.fromLine}-L${source.toLine})`,
      },
    });

    expect(link.targetId).toBe("block-1");
    expect(calls).toEqual([true, true, true, false]);
  });

  it("validates a reference at its own pins, and leaves it alone when the document repins", async () => {
    const { reviewId } = await create();
    const own = { repositoryId: "repo-b", head: "b".repeat(40) };
    const validated: { pins: unknown; file: string }[] = [];
    const pinned: unknown[] = [];

    providers.validateSource = async (pins, source) => {
      validated.push({ pins, file: source.file });
    };

    providers.validatePins = async (pins) => {
      pinned.push(pins);
    };

    await edit(reviewId, {
      type: "insert",
      content: {
        type: "code_peek",
        source: { ...selectSource(source), file: "src/other.ts", pins: own },
      },
    });
    await edit(reviewId, {
      type: "insert",
      content: {
        type: "markdown",
        markdown: "[keep](review-source:head/src/store.ts#L1-L5)",
      },
    });

    // The peek was read at its own pins (base defaults to head); the link at the document's.
    expect(validated).toEqual([
      { pins: { ...own, base: own.head }, file: "src/other.ts" },
      { pins, file: source.file },
    ]);
    expect(pinned).toEqual([{ ...own, base: own.head }]);

    validated.length = 0;
    await store.execute(
      request({ type: "repin", reviewId, pins: { ...pins, head: "new-head" } }),
    );

    // Repinning the document re-checks inherited references only.
    expect(validated).toEqual([
      { pins: { ...pins, head: "new-head" }, file: source.file },
    ]);

    // Rejected at the command boundary, before any validation runs.
    await expect(async () =>
      edit(reviewId, {
        type: "insert",
        content: {
          type: "code_peek",
          source: {
            file: "src/other.ts",
            start: { side: "base", line: 1 },
            end: { side: "base", line: 2 },
            pins: own,
          },
        },
      }),
    ).rejects.toThrow(/base-side endpoint needs base pins/);
  });

  it("keeps one scratchpad: made on demand, drawn on at explicit pins only, outside the review lifecycle", async () => {
    await store.ensureScratchpad();
    await store.ensureScratchpad();
    const pad = store.read(SCRATCHPAD_ID);
    expect(pad).toMatchObject({ kind: "scratchpad", title: "Scratchpad" });
    expect(pad.pins).toBeUndefined();
    expect(pad.target).toBeUndefined();
    expect(store.list()).toMatchObject([
      { reviewId: SCRATCHPAD_ID, kind: "scratchpad" },
    ]);
    await expect(
      store.execute(
        request({ type: "create", title: "Another", kind: "scratchpad" }),
      ),
    ).rejects.toMatchObject({ status: 409 });

    // Nothing to inherit: a reference must name its own pins.
    await expect(
      edit(SCRATCHPAD_ID, {
        type: "insert",
        content: { type: "code_peek", source: selectSource(source) },
      }),
    ).rejects.toThrow(/document has no pins/);
    const own = { repositoryId: "repo-b", head: "b".repeat(40) };
    await edit(SCRATCHPAD_ID, {
      type: "insert",
      content: {
        type: "code_peek",
        source: { ...selectSource(source), pins: own },
      },
    });
    await edit(SCRATCHPAD_ID, {
      type: "insert",
      content: {
        type: "markdown",
        markdown: "[store](review-source:head/src/store.ts#L1)",
        pins: own,
      },
    });

    const refused = [
      { type: "delete", reviewId: SCRATCHPAD_ID },
      { type: "attention", reviewId: SCRATCHPAD_ID, action: "view" },
      { type: "rename", reviewId: SCRATCHPAD_ID, title: "Notes" },
      { type: "repin", reviewId: SCRATCHPAD_ID, pins },
      {
        type: "set_target",
        reviewId: SCRATCHPAD_ID,
        target: { kind: "commits", repositoryId: "repo", head: "h" },
      },
    ];

    for (const operation of refused)
      await expect(store.execute(request(operation))).rejects.toMatchObject({
        status: 409,
      });
    expect(store.read(SCRATCHPAD_ID).version).toBe(2);
    await store.execute(
      request({ type: "restore", reviewId: SCRATCHPAD_ID, version: 1 }),
    );
    expect(store.read(SCRATCHPAD_ID).document).toHaveLength(1);
  });

  it("logs the scratchpad newest first while a review keeps appending", async () => {
    await store.ensureScratchpad();
    const note = (markdown: string) => ({ type: "markdown", markdown });

    const order = (reviewId: string) =>
      store
        .read(reviewId)
        .document.map((block) => "markdown" in block && block.markdown);

    const first = await edit(SCRATCHPAD_ID, {
      type: "insert",
      content: note("first"),
    });

    await edit(SCRATCHPAD_ID, { type: "insert", content: note("second") });
    expect(order(SCRATCHPAD_ID)).toEqual(["second", "first"]);

    // An explicit anchor still wins: the block lands after it, not on top.
    await edit(SCRATCHPAD_ID, {
      type: "insert",
      content: note("after first"),
      afterId: first.targetId,
    });
    expect(order(SCRATCHPAD_ID)).toEqual(["second", "first", "after first"]);

    const { reviewId } = await create();
    await edit(reviewId, { type: "insert", content: note("first") });
    await edit(reviewId, { type: "insert", content: note("second") });
    expect(order(reviewId)).toEqual(["first", "second"]);
  });

  it("serializes edits through async validation and preserves different-field patches", async () => {
    const { reviewId } = await create();

    const { targetId } = await edit(reviewId, {
      type: "insert",
      content: { type: "code", text: "old", caption: "old" },
    });

    let release!: () => void, started!: () => void;

    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });

    providers.validateSource = () => {
      started();

      return new Promise((resolve) => {
        release = resolve;
      });
    };

    const pending = edit(reviewId, {
      type: "insert",
      content: { type: "code_peek", source: selectSource(source) },
    });

    await entered;

    const a = edit(reviewId, {
      type: "update",
      targetId,
      changes: { text: "first" },
    });

    const b = edit(reviewId, {
      type: "update",
      targetId,
      changes: { caption: "second" },
    });

    release();
    await Promise.all([pending, a, b]);
    expect(store.inspect(reviewId, targetId)).toMatchObject({
      text: "first",
      caption: "second",
    });
    await edit(reviewId, {
      type: "update",
      targetId,
      changes: { text: "last" },
    });
    expect(store.inspect(reviewId, targetId)).toMatchObject({
      text: "last",
      caption: "second",
    });
  });

  it("replays a lost response after restart, but rejects reuse with a different edit", async () => {
    const { reviewId } = await create();

    const command = request({
      type: "edit",
      reviewId,
      edit: { type: "insert", content: { type: "divider" } },
    });

    const result = await store.execute(command);
    await store.close();
    store = new ReviewStore(database, providers);
    expect(await store.execute(command)).toEqual(result);
    expect(store.read(reviewId).document).toHaveLength(1);
    await expect(
      store.execute({
        ...command,
        operation: { type: "rename", reviewId, title: "Different" },
      }),
    ).rejects.toThrow(/already used/);
  });
});

describe("create for a pull request", () => {
  const url = "https://github.com/devdotfast/review/pull/452";

  const createFor = (
    pullRequestUrl?: string,
    fields: {
      pins?: typeof pins;
      reuseExisting?: boolean;
      title?: string;
    } = {},
  ) =>
    store.execute(
      request({
        type: "create",
        title: fields.title ?? "PR review",
        pins: fields.pins ?? pins,
        pullRequestUrl,
        ...(fields.reuseExisting !== undefined && {
          reuseExisting: fields.reuseExisting,
        }),
      }),
    );

  it("returns the PR's existing review, unchanged, instead of making another", async () => {
    const first = await createFor(url);
    expect(first).toMatchObject({ created: true });
    await edit(first.reviewId, {
      type: "insert",
      content: { type: "markdown", markdown: "Keep this" },
    });

    const again = await createFor(
      url.replace("devdotfast/review", "DevDotFast/Review"),
      {
        title: "Ignored title",
      },
    );

    expect(again).toMatchObject({
      created: false,
      reviewId: first.reviewId,
      version: 1,
      target: { kind: "commits", ...pins },
      headMoved: false,
    });
    expect(again.note).toEqual(expect.any(String));
    expect(again.ownedBy).toBeUndefined();
    expect(again.otherReviewIds).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(store.read(first.reviewId)).toMatchObject({
      title: "PR review",
      version: 1,
      origin: { pullRequestUrl: url },
    });
  });

  it("reports a moved head without moving the target", async () => {
    const { reviewId } = await createFor(url);

    const moved = await createFor(url, { pins: { ...pins, head: "new-head" } });

    expect(moved).toMatchObject({ created: false, reviewId, headMoved: true });
    expect(moved.note).toMatch(/review_set_target/);
    expect(store.read(reviewId).pins).toEqual(pins);
  });

  it("compares a requested target by the head it resolves to", async () => {
    providers.resolveTarget = vi.fn<
      NonNullable<ReviewProviders["resolveTarget"]>
    >(async (target) => ({
      target,
      pins: {
        ...pins,
        head:
          target.kind === "commits" && target.head === "main"
            ? pins.head
            : "other",
      },
    }));
    const target = { kind: "commits", repositoryId: "repo", head: "main" };

    const { reviewId } = await store.execute(
      request({ type: "create", title: "PR", target, pullRequestUrl: url }),
    );

    expect(
      await store.execute(
        request({ type: "create", title: "PR", target, pullRequestUrl: url }),
      ),
    ).toMatchObject({ created: false, reviewId, headMoved: false });
    expect(
      await store.execute(
        request({
          type: "create",
          title: "PR",
          target: { ...target, head: "feature" },
          pullRequestUrl: url,
        }),
      ),
    ).toMatchObject({ created: false, reviewId, headMoved: true });
  });

  it("creates another review on request and then returns the newest, naming the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    const at = (minute: number) =>
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 22, 12, minute)));

    at(0);
    const oldest = await createFor(url);
    at(1);
    const newer = await createFor(url, { reuseExisting: false });

    expect(newer).toMatchObject({ created: true });
    expect(newer.reviewId).not.toBe(oldest.reviewId);

    const found = await createFor(url);

    expect(found).toMatchObject({
      created: false,
      reviewId: newer.reviewId,
      otherReviewIds: [oldest.reviewId],
    });

    // Editing the older review makes it the most recently updated.
    at(2);
    await edit(oldest.reviewId, {
      type: "insert",
      content: { type: "divider" },
    });
    expect(await createFor(url)).toMatchObject({
      reviewId: oldest.reviewId,
      otherReviewIds: [newer.reviewId],
    });
    expect(store.list()).toHaveLength(2);
  });

  it("says when another session is authoring the review it returns", async () => {
    const { reviewId } = await createFor(url);
    const leaseId = randomUUID();
    store.activity.update(reviewId, { action: "begin", leaseId });

    const found = await createFor(url);

    expect(found).toMatchObject({
      created: false,
      reviewId,
      ownedBy: "another session",
    });
    expect(
      await store.execute({
        ...request({ type: "create", title: "PR", pins, pullRequestUrl: url }),
        leaseId,
      }),
    ).not.toHaveProperty("ownedBy");
  });

  it("replays a found review for a repeated command and rejects a changed one", async () => {
    const { reviewId } = await createFor(url);

    const repeat = request({
      type: "create",
      title: "PR",
      pins,
      pullRequestUrl: url,
    });

    const found = await store.execute(repeat);
    await edit(reviewId, { type: "insert", content: { type: "divider" } });
    await store.close();
    store = new ReviewStore(database, providers);

    expect(await store.execute(repeat)).toEqual(found);
    await expect(
      store.execute({
        ...repeat,
        operation: { ...repeat.operation, reuseExisting: false },
      }),
    ).rejects.toThrow(/already used/);
    expect(store.list()).toHaveLength(1);

    await store.execute(request({ type: "delete", reviewId }));
    await expect(store.execute(repeat)).rejects.toThrow(/was deleted/);
  });

  it("leaves creates without a PR, other PRs and the scratchpad alone", async () => {
    const first = await createFor(undefined);
    const second = await createFor(undefined);
    const otherPr = await createFor(url);
    const samePrElsewhere = await createFor(url.replace("452", "4520"));

    for (const result of [first, second, otherPr, samePrElsewhere])
      expect(result).toMatchObject({ created: true });
    await store.ensureScratchpad();
    expect(store.read(SCRATCHPAD_ID).kind).toBe("scratchpad");
    expect(store.list()).toHaveLength(5);
  });

  it("takes the source and title from the PR when only its URL is given", async () => {
    const resolvePullRequest = vi.fn<
      NonNullable<ReviewProviders["resolvePullRequest"]>
    >(async () => ({
      target: { kind: "commits", ...pins },
      pins,
      title: "From GitHub",
    }));

    providers.resolvePullRequest = resolvePullRequest;

    const untitled = await store.execute(
      request({ type: "create", pullRequestUrl: url }),
    );

    const titled = await store.execute(
      request({
        type: "create",
        title: "Mine",
        pullRequestUrl: url,
        reuseExisting: false,
        repositoryId: "repo",
      }),
    );

    expect(store.read(untitled.reviewId)).toMatchObject({
      title: "From GitHub",
      pins,
      origin: { pullRequestUrl: url },
    });
    expect(store.read(titled.reviewId).title).toBe("Mine");
    expect(resolvePullRequest.mock.calls).toEqual([
      [url, { id: undefined, preferred: undefined }],
      [url, { id: "repo", preferred: undefined }],
    ]);

    // A repeat prefers the checkout of the review it will find.
    await store.execute(request({ type: "create", pullRequestUrl: url }));
    expect(resolvePullRequest).toHaveBeenLastCalledWith(url, {
      id: undefined,
      preferred: "repo",
    });
  });

  it("needs a source, and a title unless a PR supplies it", async () => {
    await expect(
      store.execute(request({ type: "create", title: "Nothing" })),
    ).rejects.toThrow(/target, legacy pins, or a pullRequestUrl/);
    await expect(
      store.execute(request({ type: "create", pins })),
    ).rejects.toThrow(/Supply a title/);
    await expect(
      store.execute(
        request({
          type: "create",
          title: "Both",
          pins,
          pullRequestUrl: url,
          repositoryId: "repo",
        }),
      ),
    ).rejects.toThrow(/repositoryId applies only/);
    expect(store.list()).toEqual([]);
  });
});
