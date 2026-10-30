import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Proposal } from "./proposals.js";
import {
  createDocumentSession,
  documentSession,
  MAX_IDLE_SESSIONS,
  type DocumentSnapshot,
  type DocumentWriter,
} from "./document-session.js";

function snapshot(
  content = "Original\n",
  sha256 = "original-sha",
  proposal: Proposal | null = null,
): DocumentSnapshot {
  return {
    content,
    sha256,
    proposal,
    previewBaseUrl: "/preview",
    previewPath: "letter.md",
  };
}

function proposal(status: Proposal["status"] = "pending", version = 1): Proposal {
  return {
    vaultId: "personal",
    path: "letter.md",
    version,
    baseContent: "Original\n",
    baseSha256: "original-sha",
    content: "Candidate\n",
    status,
    resolvedSha256: status === "accepted" ? "accepted-sha" : null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function writer(overrides: Partial<DocumentWriter> = {}) {
  let next = 0;
  const save = vi.fn<DocumentWriter["save"]>(async (path) => ({
    path,
    sha256: `saved-${(next += 1)}`,
  }));
  const refetch = vi.fn(async () => {});
  return {
    save,
    refetch,
    writer: {
      renamesToTitle: false,
      save,
      refetch,
      ...overrides,
    } satisfies DocumentWriter,
  };
}

function loaded(initial = snapshot(), io = writer(), showsProposals = false) {
  const session = createDocumentSession({
    path: "letter.md",
    showsProposals,
    delay: 500,
  });
  session.connect(io.writer);
  session.receive(initial);
  return { session, ...io };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Docs document sessions", () => {
  it("drains edits made during a save using the returned file hash", async () => {
    const first = deferred<{ path: string; sha256: string }>();
    const io = writer();
    io.save.mockImplementationOnce(() => first.promise);
    const { session, save } = loaded(snapshot(), io);
    session.edit("First\n");
    const flushing = session.flush();
    session.edit("Second\n");
    first.resolve({ path: "letter.md", sha256: "first-sha" });
    await flushing;
    expect(save.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ["First\n", "original-sha"],
      ["Second\n", "first-sha"],
    ]);
    expect(session.getSnapshot()).toMatchObject({
      dirty: false,
      saving: false,
    });
  });

  it("keeps the draft and offers both versions when another writer saves during typing", async () => {
    const { session, save } = loaded(snapshot("Line\n", "base-sha"));
    session.edit("Line mine\n");
    const theirs = snapshot("Line theirs\n", "their-sha");
    session.receive(theirs);
    expect(session.getSnapshot()).toMatchObject({
      draft: "Line mine\n",
      conflict: theirs,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(save).not.toHaveBeenCalled();
    await session.keepMine();
    expect(save.mock.calls[0]?.slice(1, 3)).toEqual(["Line mine\n", "their-sha"]);
    expect(session.getSnapshot()).toMatchObject({ conflict: null });
  });

  it("replaces the draft with the other version when the user picks it", () => {
    const { session, save } = loaded(snapshot("Line\n", "base-sha"));
    session.edit("Line mine\n");
    session.receive(snapshot("Line theirs\n", "their-sha"));
    session.useTheirs();
    expect(session.getSnapshot()).toMatchObject({
      draft: "Line theirs\n",
      dirty: false,
      conflict: null,
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("ignores the echo of its own save and stale reads from before it", async () => {
    const pending = deferred<{ path: string; sha256: string }>();
    const io = writer();
    io.save.mockImplementationOnce(() => pending.promise);
    const { session } = loaded(snapshot("Old\n", "old-sha"), io);
    session.edit("New\n");
    const flushing = session.flush();
    session.receive(snapshot("New\n", "new-sha"));
    session.edit("New and more\n");
    pending.resolve({ path: "letter.md", sha256: "new-sha" });
    await flushing;
    session.receive(snapshot("Old\n", "old-sha"));
    expect(session.getSnapshot()).toMatchObject({
      draft: "New and more\n",
      conflict: null,
    });
  });

  it("offers the newer file after a rejected save instead of retrying the stale one", async () => {
    const io = writer();
    io.save.mockRejectedValueOnce(new Error("This document changed elsewhere."));
    const { session, save, refetch } = loaded(snapshot("A\n\nB\n", "base-sha"), io);
    session.edit("A typed\n\nB\n");
    await session.flush();
    expect(refetch).toHaveBeenCalledTimes(1);
    const theirs = snapshot("A\n\nB remote\n", "remote-sha");
    session.receive(theirs);
    expect(session.getSnapshot()).toMatchObject({
      draft: "A typed\n\nB\n",
      conflict: theirs,
      error: null,
    });
    await session.keepMine();
    expect(save.mock.calls.at(-1)?.slice(1, 3)).toEqual(["A typed\n\nB\n", "remote-sha"]);
    expect(session.getSnapshot()).toMatchObject({
      conflict: null,
      error: null,
      dirty: false,
    });
  });

  it("stops saving a document that was moved or deleted elsewhere", async () => {
    const { session, save } = loaded();
    session.edit("Unsaved\n");
    session.receiveError("Path does not exist: letter.md");
    session.edit("Ignored\n");
    await vi.advanceTimersByTimeAsync(2_000);
    await session.flush();
    expect(save).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({
      phase: "unavailable",
      reason: "missing",
      last: { draft: "Unsaved\n" },
    });
  });

  it("offers a save copy of the draft only while the file itself is gone", () => {
    const { session } = loaded();
    session.edit("Unsaved\n");
    session.receiveError("unknown vault: personal");
    expect(session.getSnapshot()).toMatchObject({
      phase: "unavailable",
      reason: "unknown-vault",
      message: "unknown vault: personal",
      last: { draft: "Unsaved\n" },
    });
    session.receiveError(null);
    expect(session.getSnapshot()).toMatchObject({
      phase: "loaded",
      mode: "editing",
      draft: "Unsaved\n",
      dirty: true,
    });
  });

  it("keeps the hash and path of a save that landed while the document was unavailable", async () => {
    const pending = deferred<{ path: string; sha256: string }>();
    const io = writer();
    io.save.mockImplementationOnce(() => pending.promise);
    const { session, save } = loaded(snapshot("A\n", "a"), io);
    session.edit("B\n");
    const flushing = session.flush();
    session.receiveError("Path does not exist: letter.md");
    pending.resolve({ path: "renamed.md", sha256: "b" });
    await flushing;
    expect(session.getSnapshot()).toMatchObject({
      path: "renamed.md",
      phase: "unavailable",
      last: { base: { sha256: "b" }, draft: "B\n", dirty: false },
    });
    await session.retry();
    expect(session.getSnapshot()).toMatchObject({ path: "renamed.md", mode: "editing" });
    session.edit("C\n");
    await session.flush();
    expect(save.mock.calls.at(-1)?.slice(0, 3)).toEqual(["renamed.md", "C\n", "b"]);
    expect(session.getSnapshot()).toMatchObject({ mode: "editing", dirty: false, error: null });
  });

  it("offers the conflicting version again when a missing document comes back", () => {
    const { session } = loaded(snapshot("Line\n", "base-sha"));
    session.edit("Line mine\n");
    const theirs = snapshot("Line theirs\n", "their-sha");
    session.receive(theirs);
    session.receiveError("Path does not exist: letter.md");
    expect(session.getSnapshot()).toMatchObject({
      phase: "unavailable",
      last: { draft: "Line mine\n", dirty: true },
    });
    session.receive(theirs);
    expect(session.getSnapshot()).toMatchObject({
      mode: "editing",
      draft: "Line mine\n",
      conflict: theirs,
    });
  });

  it("moves the session to the path a save renamed the document to", async () => {
    const onRename = vi.fn();
    const session = createDocumentSession({
      path: "draft.md",
      showsProposals: false,
      delay: 500,
      onRename,
    });
    const io = writer({ renamesToTitle: true });
    io.save.mockResolvedValueOnce({ path: "meeting-notes.md", sha256: "s1" });
    session.connect(io.writer);
    session.receive(snapshot("# Draft\n"));
    session.edit("# Meeting notes\n");
    await session.flush();
    expect(io.save.mock.calls[0]).toEqual(["draft.md", "# Meeting notes\n", "original-sha", true]);
    expect(session.getSnapshot().path).toBe("meeting-notes.md");
    expect(onRename).toHaveBeenCalledWith("draft.md", "meeting-notes.md");
  });

  it("flushes a candidate before accepting and waits for the accepted document", async () => {
    const updateProposal = vi.fn<NonNullable<DocumentWriter["updateProposal"]>>(
      async (_path, content, version) => ({
        ...proposal(),
        content,
        version: version + 1,
      }),
    );
    const resolveProposal = vi.fn<NonNullable<DocumentWriter["resolveProposal"]>>(async () =>
      proposal("accepted", 3),
    );
    const { session } = loaded(
      snapshot("Original\n", "original-sha", proposal()),
      writer({ updateProposal, resolveProposal }),
      true,
    );
    session.edit("Edited candidate\n");
    const resolving = session.resolve("accept");
    await resolving;
    expect(updateProposal).toHaveBeenCalledWith("letter.md", "Edited candidate\n", 1);
    expect(resolveProposal).toHaveBeenCalledWith("letter.md", "accept", 2);
    expect(session.getSnapshot()).toMatchObject({ mode: "awaiting", version: 3 });
    session.receive(snapshot("Edited candidate\n", "accepted-sha", proposal("pending", 2)));
    expect(session.getSnapshot()).toMatchObject({ mode: "awaiting" });
    session.receive(snapshot("Edited candidate\n", "accepted-sha", proposal("accepted", 3)));
    expect(session.getSnapshot()).toMatchObject({
      mode: "editing",
      draft: "Edited candidate\n",
      dirty: false,
    });
  });

  it("adopts a read that landed during a proposal action once the action settles", async () => {
    const settled = deferred<Proposal>();
    const resolveProposal = vi.fn<NonNullable<DocumentWriter["resolveProposal"]>>(
      () => settled.promise,
    );
    const { session } = loaded(
      snapshot("Original\n", "original-sha", proposal()),
      writer({ resolveProposal }),
      true,
    );
    const resolving = session.resolve("reject");
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot()).toMatchObject({ mode: "resolving" });
    session.receive(snapshot("Original\n", "original-sha", proposal("rejected", 2)));
    expect(session.getSnapshot()).toMatchObject({ mode: "resolving", draft: "Candidate\n" });
    settled.resolve(proposal("rejected", 2));
    await resolving;
    expect(session.getSnapshot()).toMatchObject({
      mode: "editing",
      draft: "Original\n",
      base: { proposal: { status: "rejected", version: 2 } },
    });
  });

  it("does not resolve a proposal when saving its candidate fails", async () => {
    const resolveProposal = vi.fn<NonNullable<DocumentWriter["resolveProposal"]>>();
    const { session } = loaded(
      snapshot("Original\n", "original-sha", proposal()),
      writer({
        updateProposal: async () => {
          throw new Error("The proposal changed.");
        },
        resolveProposal,
      }),
      true,
    );
    session.edit("Edited candidate\n");
    await session.resolve("accept");
    expect(resolveProposal).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({
      mode: "editing",
      error: "The proposal changed.",
      draft: "Edited candidate\n",
    });
  });

  it("keeps waiting for the resolved document when a read fails after a proposal action", async () => {
    const resolveProposal = vi.fn<NonNullable<DocumentWriter["resolveProposal"]>>(async () =>
      proposal("accepted", 3),
    );
    const { session, refetch } = loaded(
      snapshot("Original\n", "original-sha", proposal()),
      writer({ resolveProposal }),
      true,
    );
    await session.resolve("accept");
    session.receiveError("fetch failed");
    expect(session.getSnapshot()).toMatchObject({
      mode: "awaiting",
      version: 3,
      error: "fetch failed",
    });
    await session.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({ mode: "awaiting", version: 3, error: null });
    session.receive(snapshot("Original\n", "original-sha", proposal("pending", 2)));
    expect(session.getSnapshot()).toMatchObject({ mode: "awaiting" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refetch).toHaveBeenCalledTimes(2);
    session.receive(snapshot("Candidate\n", "accepted-sha", proposal("accepted", 3)));
    expect(session.getSnapshot()).toMatchObject({
      mode: "editing",
      draft: "Candidate\n",
      base: { proposal: { status: "accepted", version: 3 } },
    });
  });

  it("shows a read failure during a proposal action and still lands the action", async () => {
    const settled = deferred<Proposal>();
    const resolveProposal = vi.fn<NonNullable<DocumentWriter["resolveProposal"]>>(
      () => settled.promise,
    );
    const { session } = loaded(
      snapshot("Original\n", "original-sha", proposal()),
      writer({ resolveProposal }),
      true,
    );
    const resolving = session.resolve("reject");
    await vi.advanceTimersByTimeAsync(0);
    session.receiveError("fetch failed");
    expect(session.getSnapshot()).toMatchObject({ mode: "resolving", error: "fetch failed" });
    settled.resolve(proposal("rejected", 2));
    await resolving;
    expect(session.getSnapshot()).toMatchObject({
      mode: "awaiting",
      version: 2,
      error: "fetch failed",
    });
    session.receive(snapshot("Original\n", "original-sha", proposal("rejected", 2)));
    expect(session.getSnapshot()).toMatchObject({
      mode: "editing",
      error: null,
      base: { proposal: { status: "rejected", version: 2 } },
    });
  });
});

describe("Docs external reverts and preview paths", () => {
  it("adopts an external A to B to A revert when clean", () => {
    const { session } = loaded(snapshot("A", "a"));
    session.receive(snapshot("B", "b"));
    session.receive(snapshot("A", "a"));
    expect(session.getSnapshot()).toMatchObject({
      draft: "A",
      base: { sha256: "a" },
      conflict: null,
    });
  });
  it("offers an external revert as a conflict while dirty", () => {
    const { session } = loaded(snapshot("A", "a"));
    session.receive(snapshot("B", "b"));
    session.edit("My edits");
    session.receive(snapshot("A", "a"));
    expect(session.getSnapshot()).toMatchObject({
      draft: "My edits",
      conflict: { sha256: "a", content: "A" },
    });
  });
  it("allows a revert after the local save has been confirmed by a live read", async () => {
    const { session } = loaded(snapshot("A", "a"));
    session.edit("B");
    await session.flush();
    session.receive(snapshot("B", "saved-1"));
    session.receive(snapshot("A", "a"));
    expect(session.getSnapshot()).toMatchObject({ draft: "A", conflict: null });
  });
  it("keeps a host document's relative preview path after saving its absolute path", async () => {
    const session = createDocumentSession({
      path: "/Users/shared/notes/plan.md",
      showsProposals: false,
      delay: 500,
    });
    const io = writer();
    session.connect(io.writer);
    session.receive({ ...snapshot("![Image](./image.png)", "a"), previewPath: "plan.md" });
    session.edit("![Image](./image.png)\nEdited");
    await session.flush();
    expect(session.getSnapshot()).toMatchObject({ base: { previewPath: "plan.md" } });
  });
});

describe("Docs local-write confirmation bounds", () => {
  it("ignores late pre-save previews only until an authoritative read or bounded refresh", async () => {
    const { session, refetch } = loaded(snapshot("A", "a"));
    session.edit("B");
    await session.flush();
    session.receive({ ...snapshot("A", "a"), previewBaseUrl: "/late-preview" });
    expect(session.getSnapshot()).toMatchObject({
      draft: "B",
      conflict: null,
      base: { previewBaseUrl: "/preview" },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refetch).toHaveBeenCalledOnce();
    session.receive({ ...snapshot("A", "a"), previewBaseUrl: "/fresh-preview" });
    expect(session.getSnapshot()).toMatchObject({
      draft: "A",
      conflict: null,
      base: { previewBaseUrl: "/fresh-preview" },
    });
  });
});

describe("Docs document session cache", () => {
  it("keeps an unavailable document's unsaved draft under cache pressure", () => {
    const open = (path: string) =>
      documentSession((p) => `personal:${p}`, path, { showsProposals: false, delay: 500 });
    const opened = (path: string) => {
      const session = open(path);
      session.connect(writer().writer);
      session.receive(snapshot());
      return session;
    };
    const goneDirty = opened("gone-dirty.md");
    goneDirty.edit("Unsaved\n");
    goneDirty.receiveError("Path does not exist: gone-dirty.md");
    const dirty = opened("dirty.md");
    dirty.edit("Unsaved\n");
    const goneClean = opened("gone-clean.md");
    goneClean.receiveError("Path does not exist: gone-clean.md");

    for (let i = 0; i < MAX_IDLE_SESSIONS; i += 1) open(`filler-${i}.md`);

    expect(open("gone-dirty.md")).toBe(goneDirty);
    expect(goneDirty.getSnapshot()).toMatchObject({
      phase: "unavailable",
      last: { draft: "Unsaved\n", dirty: true },
    });
    expect(open("dirty.md")).toBe(dirty);
    expect(open("gone-clean.md")).not.toBe(goneClean);
  });
});
