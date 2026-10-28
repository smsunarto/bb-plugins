// @vitest-environment jsdom
// A reply with two ```ui blocks (two React roots, as BB mounts them) against
// a composer that keeps its draft as text plus mention ranges, like BB's.
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import type { ComposerDraftReplacement, ComposerDraftSnapshot, ComposerMention, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sheetFor } from "./answerSheet";
import { SlotFence } from "./SlotFence";

/** Vitest's jsdom environment exposes the JSDOM instance; only its window is used here. */
declare const jsdom: { window: Window };

/** A thread composer as the plugin sees it, and what the user does with it. */
interface FakeComposer {
  readonly composer: PluginComposerApi;
  subscribe(listener: () => void): () => void;
  version(): number;
  /** The drafts the user sent. */
  readonly sent: ComposerDraftSnapshot[];
  /** The user edits the draft by hand. */
  edit(next: (current: ComposerDraftSnapshot) => { text: string; mentions?: readonly ComposerMention[] }): void;
  /** The user presses send: BB clears the draft and tells the plugin (when this composer reports submissions). */
  send(): void;
  /** The user types `typed` one key at a time at `at` (default: the end), each key its own draft change. */
  type(typed: string, at?: number): void;
  /** The user attaches a file. */
  addAttachment(): void;
  /** BB starts submitting: `isSubmitting` turns true, the draft object unchanged. */
  startSubmit(): void;
}

/** One thread composer: `replace`, `insert`, `onSubmitted` (unless `reports` is false) and `draft` over a string and its mentions. */
function fakeComposer(threadId: string, reports = true): FakeComposer {
  let draft: ComposerDraftSnapshot = { text: "", mentions: [], attachments: [] };
  let version = 0;
  let submitting = false;
  const listeners = new Set<() => void>();
  const submittedListeners = new Set<() => void>();
  const sent: ComposerDraftSnapshot[] = [];
  const set = (next: ComposerDraftSnapshot) => {
    draft = next;
    version++;
    for (const listener of [...listeners]) listener();
  };
  const handle = {
    scope: { kind: "thread", threadId },
    key: `thread:${threadId}`,
    get draft() {
      return draft;
    },
    get text() {
      return draft.text;
    },
    get isEmpty() {
      return draft.text.trim() === "" && draft.mentions.length === 0;
    },
    replace(next: ComposerDraftReplacement | ((current: ComposerDraftSnapshot) => ComposerDraftReplacement)) {
      const result = typeof next === "function" ? next(draft) : next;
      if (result === draft) return;
      set({ text: result.text, mentions: [...result.mentions], attachments: draft.attachments });
    },
    insert(parts: string | readonly string[], options?: { at?: "cursor" | "end"; block?: boolean }) {
      const text = typeof parts === "string" ? parts : parts.join("");
      const gap = options?.block === true && draft.text !== "" ? "\n\n" : "";
      set({ ...draft, text: `${draft.text}${gap}${text}` });
    },
    ...(reports
      ? {
          onSubmitted(listener: () => void) {
            submittedListeners.add(listener);
            return () => submittedListeners.delete(listener);
          },
        }
      : {}),
    get isSubmitting() {
      return submitting;
    },
    focus: vi.fn(),
    submit: vi.fn(),
  };
  return {
    composer: handle as unknown as PluginComposerApi,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
    sent,
    /** The user edits the draft by hand. */
    edit(next: (current: ComposerDraftSnapshot) => { text: string; mentions?: readonly ComposerMention[] }) {
      const result = next(draft);
      set({ text: result.text, mentions: [...(result.mentions ?? draft.mentions)], attachments: draft.attachments });
    },
    send() {
      sent.push(draft);
      set({ text: "", mentions: [], attachments: [] });
      for (const listener of [...submittedListeners]) listener();
      submitting = false;
    },
    type(typed: string, at?: number) {
      let position = at ?? draft.text.length;
      for (const key of typed) {
        act(() => set({ ...draft, text: `${draft.text.slice(0, position)}${key}${draft.text.slice(position)}` }));
        position++;
      }
    },
    addAttachment() {
      set({ ...draft, attachments: [...draft.attachments, { type: "localFile", path: "/tmp/spec.pdf", name: "spec.pdf" }] });
    },
    startSubmit() {
      submitting = true;
      version++;
      for (const listener of [...listeners]) listener();
    },
  };
}

const bb = vi.hoisted(() => ({
  composers: null as null | FakeComposer,
  send: vi.fn(async () => ({})),
  superseded: false,
  supersededListeners: new Set<() => void>(),
}));

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  useComposers: () => {
    const fake = bb.composers;
    useSyncExternalStore(fake?.subscribe ?? (() => () => undefined), () => fake?.version() ?? 0);
    return fake === null ? [] : [fake.composer];
  },
  useSdk: () => ({ threads: { send: bb.send } }),
  useBbNavigate: () => ({}),
  useRpc: () => ({ call: vi.fn() }),
  useSettings: () => ({ values: { animations: false }, isLoading: false }),
  Markdown: ({ content }: { content: string }) => <p>{content}</p>,
  experimental_Icon: () => <span aria-hidden="true" />,
}));
vi.mock("./useSuperseded", () => ({
  useSuperseded: () =>
    useSyncExternalStore(
      (listener) => {
        bb.supersededListeners.add(listener);
        return () => bb.supersededListeners.delete(listener);
      },
      () => bb.superseded,
    ),
  useReplyIndex: () => 4,
}));

/** A user message lands after the reply. */
function supersede() {
  act(() => {
    bb.superseded = true;
    for (const listener of [...bb.supersededListeners]) listener();
  });
}

const CHOICE = `Card("Which plan?", [Button("Basic"), Button("Pro")])`;
const FORM = `$name = ""
$formats = []
Card("A few details", [Form([
  Input($name, label: "Project name"),
  Checklist($formats, ["CSV", "JSON", "XLSX"], label: "Which formats?")
])])`;

let thread = 0;
let fake: FakeComposer;
let block1: HTMLElement;
let block2: HTMLElement;

/** Mounts the reply's two blocks as BB does: one root per fence. */
function mountReply(threadId: string, Fence: typeof SlotFence = SlotFence) {
  const message = { id: `${threadId}:assistant:7`, threadId, turnId: "turn", projectId: "project" };
  const original = () => <pre />;
  block1 = render(<Fence language="ui" status="closed" code={CHOICE} index={0} message={message} Original={original} />).container;
  block2 = render(<Fence language="ui" status="closed" code={FORM} index={1} message={message} Original={original} />).container;
}

const pressed = (block: HTMLElement, name: string) => within(block).getByRole("button", { name }).getAttribute("aria-pressed");

/** Lets `ms` pass: a typed field's pause, a choice's fold. (The project's lib predates Promise.withResolvers.) */
async function wait(ms: number) {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A fresh module load (the reload test) reads it at load, after unstubAllGlobals dropped test-setup's.
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("CSS", { supports: () => false });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Node 25+ has its own global localStorage (undefined without --localstorage-file), which hides jsdom's.
  vi.stubGlobal("localStorage", jsdom.window.localStorage);
  localStorage.clear();
  thread++;
  fake = fakeComposer(`thr_${thread}`);
  bb.composers = fake;
  bb.send.mockClear();
  bb.superseded = false;
  mountReply(`thr_${thread}`);
});

afterEach(() => {
  cleanup();
  bb.composers = null;
  vi.unstubAllGlobals();
});

describe("the composer is the answer sheet", () => {
  it("stages every question of both blocks into one answers block, in reply order, around the user's own text", async () => {
    // The user starts writing first.
    act(() => fake.edit(() => ({ text: "Thanks!" })));
    // Block 1: a pick toggles on; nothing is sent.
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    expect(pressed(block1, "Pro")).toBe("true");
    expect(fake.composer.draft.text).toBe("Thanks!\n\nPro");
    // Block 2: the first edit of a field stages the whole Form, picked and not picked.
    fireEvent.click(within(block2).getByRole("checkbox", { name: "JSON" }));
    expect(fake.composer.draft.text).toBe("Thanks!\n\nPro\nProject name: —\nWhich formats? JSON (not: CSV, XLSX)");
    fireEvent.change(within(block2).getByLabelText("Project name"), { target: { value: "Orbit" } });
    // Typing waits for a pause.
    expect(fake.composer.draft.text).toContain("Project name: —");
    await wait(350);
    expect(fake.composer.draft.text).toBe("Thanks!\n\nPro\nProject name: Orbit\nWhich formats? JSON (not: CSV, XLSX)");
    expect(within(block2).getByText("In your message")).toBeTruthy();

    // The user writes on after the block, with a mention pill.
    act(() =>
      fake.edit(({ text }) => {
        const added = `${text}\n\nAsk @Sam`;
        return { text: added, mentions: [{ from: added.length - 4, to: added.length, label: "@Sam", kind: "thread", threadId: "thr_sam" }] };
      }),
    );
    // Changing the pick rewrites the block in place: the user's text stays, the mention moves with it.
    fireEvent.click(within(block1).getByRole("button", { name: "Basic" }));
    expect(pressed(block1, "Basic")).toBe("true");
    expect(pressed(block1, "Pro")).toBe("false");
    const draft = fake.composer.draft;
    expect(draft.text).toBe("Thanks!\n\nBasic\nProject name: Orbit\nWhich formats? JSON (not: CSV, XLSX)\n\nAsk @Sam");
    expect(draft.mentions).toEqual([{ from: draft.text.length - 4, to: draft.text.length, label: "@Sam", kind: "thread", threadId: "thr_sam" }]);
    expect(draft.text.slice(draft.mentions[0].from, draft.mentions[0].to)).toBe("@Sam");
    // Picking it again takes it out of the block, and nothing else.
    fireEvent.click(within(block1).getByRole("button", { name: "Basic" }));
    expect(pressed(block1, "Basic")).toBe("false");
    expect(fake.composer.draft.text).toBe("Thanks!\n\nProject name: Orbit\nWhich formats? JSON (not: CSV, XLSX)\n\nAsk @Sam");
    expect(bb.send).not.toHaveBeenCalled();
  });

  it("deselects every answer when the user deletes the block from the draft, and leaves their text alone", async () => {
    act(() => fake.edit(() => ({ text: "Hi" })));
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    fireEvent.click(within(block2).getByRole("checkbox", { name: "CSV" }));
    expect(fake.composer.draft.text).toBe("Hi\n\nPro\nProject name: —\nWhich formats? CSV (not: JSON, XLSX)");

    act(() => fake.edit(() => ({ text: "Hi" })));
    expect(pressed(block1, "Pro")).toBe("false");
    expect(within(block2).queryByText("In your message")).toBeNull();
    expect(fake.composer.draft.text).toBe("Hi");
    // The fields keep what the user set; the next edit stages the Form afresh.
    fireEvent.click(within(block2).getByRole("checkbox", { name: "JSON" }));
    expect(fake.composer.draft.text).toBe("Hi\n\nProject name: —\nWhich formats? CSV, JSON (not: XLSX)");
  });

  it("treats an edited block as the user's text and writes a fresh block after it", () => {
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    act(() => fake.edit(() => ({ text: "Pro, unless Basic has SSO" })));
    // The answer stays picked: the user's words still say it.
    expect(pressed(block1, "Pro")).toBe("true");
    fireEvent.click(within(block2).getByRole("checkbox", { name: "XLSX" }));
    expect(fake.composer.draft.text).toBe("Pro, unless Basic has SSO\n\nPro\nProject name: —\nWhich formats? XLSX (not: CSV, JSON)");
  });

  it("folds both blocks into their sent answers once the user sends the draft", async () => {
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    fireEvent.click(within(block2).getByRole("checkbox", { name: "CSV" }));
    act(() => fake.send());
    expect(fake.sent.map((draft) => draft.text)).toEqual(["Pro\nProject name: —\nWhich formats? CSV (not: JSON, XLSX)"]);
    // Block 1: the choice folds into the line of what was sent.
    await wait(250);
    expect(within(block1).getByRole("status").textContent).toContain("Pro");
    expect(within(block1).queryByRole("button", { name: "Basic" })).toBeNull();
    // Block 2: the Form turns read-only with "Sent".
    expect(within(block2).getByText("Sent")).toBeTruthy();
    expect(within(block2).getByRole("checkbox", { name: "CSV" }).closest("fieldset")?.disabled).toBe(true);
    expect(bb.send).not.toHaveBeenCalled();
  });

  it("restores the picks after a reload from a fresh store, the sheet in localStorage and the draft BB kept", async () => {
    act(() => fake.edit(() => ({ text: "Hi" })));
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    const kept = fake.composer.draft.text;
    cleanup();
    // A fresh page: new modules (an empty sheet registry), a new composer handle holding the draft BB kept.
    vi.resetModules();
    const { SlotFence: Fresh } = await import("./SlotFence");
    fake = fakeComposer(`thr_${thread}`);
    bb.composers = fake;
    act(() => fake.edit(() => ({ text: kept })));
    mountReply(`thr_${thread}`, Fresh);
    expect(fake.composer.draft.text).toBe("Hi\n\nPro");
    expect(pressed(block1, "Pro")).toBe("true");
    // The restored sheet still knows where its block stands: a switch rewrites it in place.
    fireEvent.click(within(block1).getByRole("button", { name: "Basic" }));
    expect(fake.composer.draft.text).toBe("Hi\n\nBasic");
  });

  it("switching a pick rewrites only the sheet's block when the user typed the same answer after it", () => {
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    expect(fake.composer.draft.text).toBe("Pro");
    fake.type("\n\nPro");
    expect(pressed(block1, "Pro")).toBe("true");
    fireEvent.click(within(block1).getByRole("button", { name: "Basic" }));
    expect(fake.composer.draft.text).toBe("Basic\n\nPro");
  });

  it("keeps a multi-paragraph TextArea answer one block: switching another pick never duplicates it", async () => {
    const message = { id: `thr_${thread}:assistant:7`, threadId: `thr_${thread}`, turnId: "turn", projectId: "project" };
    const notes = render(
      <SlotFence language="ui" status="closed" code={`$notes = ""\nForm([TextArea($notes, label: "Notes")])`} index={2} message={message} Original={() => <pre />} />,
    ).container;
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    fireEvent.change(within(notes).getByLabelText("Notes"), { target: { value: "first\n\nsecond" } });
    await wait(350);
    expect(fake.composer.draft.text).toBe("Pro\nNotes: first\n\nsecond");
    fireEvent.click(within(block1).getByRole("button", { name: "Basic" }));
    expect(fake.composer.draft.text).toBe("Basic\nNotes: first\n\nsecond");
  });

  it("never counts a deleted block as sent when the user then sends something else", async () => {
    act(() => fake.edit(() => ({ text: "Hi" })));
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    act(() => fake.edit(() => ({ text: "Hi" })));
    act(() => fake.send());
    await wait(250);
    expect(fake.sent.map((draft) => draft.text)).toEqual(["Hi"]);
    expect(within(block1).queryByRole("status")).toBeNull();
    expect(pressed(block1, "Pro")).toBe("false");
  });

  it("doesn't send a pick the user cleared with the whole draft, beside a later one", async () => {
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    act(() => fake.edit(() => ({ text: "" })));
    fireEvent.click(within(block1).getByRole("button", { name: "Basic" }));
    expect(fake.composer.draft.text).toBe("Basic");
    act(() => fake.send());
    await wait(250);
    expect(fake.sent.map((draft) => draft.text)).toEqual(["Basic"]);
    expect(within(block1).getByRole("status").textContent).toContain("Basic");
    expect(within(block1).getByRole("status").textContent).not.toContain("Pro");
  });

  it("settles the answers as sent on supersession where the composer reports no submissions", async () => {
    cleanup();
    thread++;
    fake = fakeComposer(`thr_${thread}`, false);
    bb.composers = fake;
    mountReply(`thr_${thread}`);
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    fireEvent.click(within(block2).getByRole("checkbox", { name: "CSV" }));
    act(() => fake.send());
    // The draft cleared on send is not a deletion: the picks wait for the send to show.
    expect(pressed(block1, "Pro")).toBe("true");
    supersede();
    await wait(250);
    expect(within(block1).getByRole("status").textContent).toContain("Pro");
    expect(within(block2).getByText("Sent")).toBeTruthy();
  });

  it("writes a staged Form's last typing before a send: on leaving the field, and on Enter", () => {
    fireEvent.click(within(block2).getByRole("checkbox", { name: "CSV" }));
    const name = within(block2).getByLabelText("Project name");
    fireEvent.change(name, { target: { value: "Orbit" } });
    fireEvent.focusOut(name);
    expect(fake.composer.draft.text).toBe("Project name: Orbit\nWhich formats? CSV (not: JSON, XLSX)");
    fireEvent.change(name, { target: { value: "Orbital" } });
    fireEvent.keyDown(document.body, { key: "Enter" });
    act(() => fake.send());
    expect(fake.sent.map((draft) => draft.text)).toEqual(["Project name: Orbital\nWhich formats? CSV (not: JSON, XLSX)"]);
  });

  it("stages a Form only on the user's own edit, never because the sheet's entry changed elsewhere", () => {
    fireEvent.click(within(block2).getByRole("checkbox", { name: "CSV" }));
    const sheet = sheetFor(`thr_${thread}`);
    const block = `bb.genui.state:thr_${thread}:assistant:7#ui#1`;
    const [staged] = sheet.snapshot(block).staged.values();
    // Another writer (a second window, say) replaces the entry.
    act(() => sheet.stage({ ...staged, text: "Elsewhere: yes" }));
    expect(fake.composer.draft.text).toBe("Elsewhere: yes");
    // Renders, draft changes and time pass: the Form doesn't write itself back.
    act(() => fake.edit(({ text }) => ({ text: `${text}\n\nok` })));
    expect(fake.composer.draft.text).toBe("Elsewhere: yes\n\nok");
    expect([...sheet.snapshot(block).staged.values()].map((item) => item.text)).toEqual(["Elsewhere: yes"]);
  });

  it("marks nothing sent when the user clears the draft, attaches a file and sends", async () => {
    fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    act(() => fake.edit(() => ({ text: "" })));
    act(() => fake.addAttachment());
    expect(pressed(block1, "Pro")).toBe("false");
    act(() => fake.send());
    await wait(250);
    expect(within(block1).queryByRole("status")).toBeNull();
    expect(within(block1).getByRole("button", { name: "Pro" })).toBeTruthy();
  });

  it("writes a Form's pending typing when BB starts submitting, though the draft object is the same", () => {
    fireEvent.click(within(block2).getByRole("checkbox", { name: "CSV" }));
    fireEvent.change(within(block2).getByLabelText("Project name"), { target: { value: "Orbit" } });
    const before = fake.composer.draft;
    expect(before.text).toContain("Project name: —");
    act(() => fake.startSubmit());
    expect(fake.composer.draft.text).toBe("Project name: Orbit\nWhich formats? CSV (not: JSON, XLSX)");
  });

  it("sends a pick at once only where the thread has no composer", async () => {
    cleanup();
    bb.composers = null;
    thread++;
    mountReply(`thr_${thread}`);
    await act(async () => {
      fireEvent.click(within(block1).getByRole("button", { name: "Pro" }));
    });
    expect(bb.send).toHaveBeenCalledWith({ threadId: `thr_${thread}`, mode: "queue-if-active", input: [{ type: "text", text: "Pro", mentions: [] }] });
    // The Form keeps a fixed Send button there.
    expect(within(block2).getByRole("button", { name: "Send" })).toBeTruthy();
  });
});
