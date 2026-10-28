// The answer sheet: every reply choice and Form edit in a thread's blocks is
// staged here, and the sheet keeps one plain-text "answers block" in the
// thread's composer draft in step with it. Nothing a user picks is sent on its
// own: they send with BB's own send button, with whatever they type around
// the block. Blocks are separate React roots (one per fence), so the sheet
// is a module-level store per thread that each block subscribes to. The
// pure rules (order, writing the block, following it through the user's
// edits) are in core/answers.ts.
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { answersText, trackBlock, writeBlock, type StagedEntry, type WrittenBlock } from "../core/answers";

/** What a question's control shows as picked: a button's key, a row's index, `true` for a touched Form or an approved Plan. */
export type Selection = string | number | boolean;

/** One staged answer of a block's question. */
export interface SheetEntry extends StagedEntry {
  /** The block's persistent key (its stateKey). */
  readonly block: string;
  /** The question within the block. */
  readonly question: string;
  readonly selection: Selection;
}

/** An answer the block sent. `question` is null for one sent before answers were staged (one per block, matched by its text). */
export interface SentAnswer {
  readonly question: string | null;
  readonly text: string;
}

/** What one block reads from the sheet. */
export interface BlockAnswers {
  /** Its staged answers, by question. */
  readonly staged: ReadonlyMap<string, SheetEntry>;
  /** What it sent; null until it sent anything. */
  readonly sent: readonly SentAnswer[] | null;
  /** The thread's composer takes the answers; without one they are sent at once. */
  readonly composer: boolean;
}

/** The sheet as kept in localStorage: read once on load, written on every change. */
interface Saved {
  readonly entries: readonly SheetEntry[];
  readonly written: WrittenBlock | null;
  /** The draft text `written` stands in. */
  readonly base: string | null;
  readonly sending: boolean;
}

const EMPTY: ReadonlyMap<string, SheetEntry> = new Map();

function isSelection(value: unknown): value is Selection {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function readEntry(value: unknown): SheetEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  const strings = [entry.block, entry.question, entry.message, entry.text].every((field) => typeof field === "string");
  const numbers = [entry.fence, entry.position, entry.seq].every((field) => typeof field === "number");
  const reply = entry.reply === null || typeof entry.reply === "number";
  return strings && numbers && reply && isSelection(entry.selection) ? (entry as unknown as SheetEntry) : null;
}

function readWritten(value: unknown): WrittenBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const { text, from, to } = value as Record<string, unknown>;
  return typeof text === "string" && typeof from === "number" && typeof to === "number" ? { text, from, to } : null;
}

/** A saved sheet from its JSON; null for anything else (an older format, damage). */
function readSaved(raw: string | null): Saved | null {
  if (raw === null) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof saved !== "object" || saved === null) return null;
  const { entries, written, base, sending } = saved as Record<string, unknown>;
  if (!Array.isArray(entries)) return null;
  const block = readWritten(written);
  return {
    entries: entries.flatMap((item) => readEntry(item) ?? []),
    written: block,
    base: block !== null && typeof base === "string" ? base : null,
    sending: sending === true,
  };
}

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the sheet keeps working for this page.
  }
}

/**
 * What a block sent, from localStorage: `<block>:answers`, else the single
 * answer `<block>:answer` a block kept before answers were staged.
 */
function readSent(block: string): SentAnswer[] | null {
  const raw = readItem(`${block}:answers`);
  if (raw !== null) {
    try {
      const saved: unknown = JSON.parse(raw);
      const answers = Array.isArray(saved)
        ? saved.filter(
            (item): item is SentAnswer =>
              typeof item === "object" && item !== null && typeof item.text === "string" && (item.question === null || typeof item.question === "string"),
          )
        : [];
      return answers.length === 0 ? null : answers;
    } catch {
      return null;
    }
  }
  const legacy = readItem(`${block}:answer`);
  return legacy === null ? null : [{ question: null, text: legacy }];
}

const keyOf = (entry: { readonly block: string; readonly question: string }) => `${entry.block}\n${entry.question}`;

interface Attached {
  readonly composer: PluginComposerApi;
  count: number;
  readonly dispose: () => void;
}

export class AnswerSheet {
  private entries: SheetEntry[] = [];
  /** The answers block the sheet wrote and where it stands in `base`; null when the draft holds none of it. */
  private written: WrittenBlock | null = null;
  /** The draft text the sheet last saw (or wrote) with its block in it. */
  private base: string | null = null;
  /**
   * The draft emptied with the block in it, and BB wasn't (yet) seen
   * submitting: the answers stay staged until the send is confirmed
   * (`onSubmitted`, or the reply superseded) or the user writes on, which
   * makes it a deletion.
   */
  private sending = false;
  private seq = 0;
  /** Whether BB was submitting when the sheet last looked, so a send that starts is seen once, draft change or not. */
  private submitting = false;
  private readonly sent = new Map<string, SentAnswer[] | null>();
  private readonly snapshots = new Map<string, BlockAnswers>();
  private readonly listeners = new Set<() => void>();
  private readonly attached: Attached[] = [];
  /** The last draft `observe` read, so the same draft is never judged twice. */
  private lastDraft: unknown = null;
  /** The draft text a write replaced, until the write shows: a draft still reading so is stale, not an edit. */
  private pendingBefore: string | null = null;

  /**
   * `storageKey` null keeps the sheet in memory only (the gallery). The
   * sheet is read once here and written on every change: another window on
   * the thread doesn't merge in, the last write wins.
   */
  constructor(private readonly storageKey: string | null) {
    const saved = storageKey === null ? null : readSaved(readItem(storageKey));
    if (saved === null) return;
    this.entries = [...saved.entries];
    this.written = saved.written;
    this.base = saved.base;
    this.sending = saved.sending;
    this.seq = Math.max(0, ...this.entries.map((entry) => entry.seq + 1));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** One block's view of the sheet; the same object until something of that block changes. */
  snapshot(block: string): BlockAnswers {
    let snapshot = this.snapshots.get(block);
    if (snapshot === undefined) {
      const own = this.entries.filter((entry) => entry.block === block);
      if (!this.sent.has(block)) this.sent.set(block, this.storageKey === null ? null : readSent(block));
      snapshot = {
        staged: own.length === 0 ? EMPTY : new Map(own.map((entry) => [entry.question, entry])),
        sent: this.sent.get(block) ?? null,
        composer: this.composer() !== null,
      };
      this.snapshots.set(block, snapshot);
    }
    return snapshot;
  }

  /** Stages (or restages) a question's answer. */
  stage(entry: Omit<SheetEntry, "seq">): void {
    const blocks = this.confirmDeletion();
    const index = this.entries.findIndex((item) => keyOf(item) === keyOf(entry));
    const seq = index === -1 ? this.seq++ : this.entries[index].seq;
    const next = { ...entry, seq };
    this.entries = index === -1 ? [...this.entries, next] : this.entries.map((item, at) => (at === index ? next : item));
    this.commit([...blocks, entry.block]);
  }

  /** Withdraws a question's answer (the user picked it again). */
  withdraw(block: string, question: string): void {
    const blocks = this.confirmDeletion();
    const key = keyOf({ block, question });
    if (!this.entries.some((item) => keyOf(item) === key)) {
      if (blocks.length > 0) this.commit(blocks);
      return;
    }
    this.entries = this.entries.filter((item) => keyOf(item) !== key);
    this.commit([...blocks, block]);
  }

  /** Records an answer sent without the composer (no composer for the thread). */
  markSent(block: string, question: string, text: string): void {
    this.addSent(block, [{ question, text }]);
    this.commit([block]);
  }

  /**
   * Lets the sheet write into `composer` (a thread composer) and hear its
   * submissions. Counted: every block on screen attaches the composers it
   * sees; the last detach lets go.
   */
  attach(composer: PluginComposerApi): () => void {
    let attachment = this.attached.find((item) => item.composer === composer);
    if (attachment === undefined) {
      const dispose = typeof composer.onSubmitted === "function" ? composer.onSubmitted(() => this.submitted()) : () => undefined;
      attachment = { composer, count: 0, dispose };
      this.attached.push(attachment);
      if (this.attached.length === 1) this.commit(null);
    }
    const held = attachment;
    held.count++;
    return () => {
      held.count--;
      if (held.count > 0) return;
      held.dispose();
      this.attached.splice(this.attached.indexOf(held), 1);
      if (this.attached.length === 0) this.commit(null);
    };
  }

  /**
   * Follows the block through the composer's draft: the composer is the
   * truth for what will be sent. Text typed beside the block moves it; an
   * edit inside it (or one that can't be told apart from the user's own
   * text) makes it the user's, and the next change writes a fresh block; a
   * deletion withdraws its answers. A draft emptied while BB submits is the
   * send; emptied otherwise, it waits to see which it was. A send that
   * starts first writes any Form answer still waiting out its typing pause.
   */
  observe(composer: PluginComposerApi): void {
    if (composer !== this.composer()) return;
    const submitting = composer.isSubmitting;
    if (submitting && !this.submitting) flushAnswers();
    this.submitting = submitting;
    const draft = composer.draft;
    if (draft === this.lastDraft) return;
    this.lastDraft = draft;
    const empty = draft.text.trim() === "" && draft.mentions.length === 0 && draft.attachments.length === 0;
    if (this.sending) {
      // Anything in the draft after emptying it (text, a mention, an attachment): that was a deletion, not a send.
      if (!empty) this.commit(this.confirmDeletion());
      return;
    }
    if (this.written === null || this.base === null) return;
    if (this.pendingBefore !== null && draft.text === this.pendingBefore) return;
    this.pendingBefore = null;
    const tracked = trackBlock(this.base, draft, this.written);
    if (tracked.kind === "present") {
      this.written = { text: this.written.text, from: tracked.from, to: tracked.to };
      this.base = draft.text;
      this.persist();
      return;
    }
    this.written = null;
    this.base = null;
    if (tracked.kind === "edited") {
      this.persist();
      return;
    }
    if (empty && submitting) {
      this.submitted();
      return;
    }
    if (empty) {
      this.sending = true;
      this.commit(null);
      return;
    }
    const blocks = this.entries.map((entry) => entry.block);
    this.entries = [];
    this.commit(blocks);
  }

  /** The user sent the draft: every staged answer becomes its block's sent answer. */
  submitted(): void {
    const sent = this.entries;
    this.entries = [];
    this.written = null;
    this.base = null;
    this.sending = false;
    this.pendingBefore = null;
    const blocks = [...new Set(sent.map((entry) => entry.block))];
    for (const block of blocks) {
      this.addSent(
        block,
        sent.filter((entry) => entry.block === block).map((entry) => ({ question: entry.question, text: entry.text })),
      );
    }
    this.commit(blocks);
  }

  /**
   * The reply holding `block` now has a user message after it. When the
   * draft emptied with its answers in it, that message was them: they are
   * sent (the fallback for a composer that reports no submissions).
   */
  supersede(block: string): void {
    if (!this.sending) return;
    const settled = this.entries.filter((entry) => entry.block === block);
    if (settled.length === 0) return;
    this.entries = this.entries.filter((entry) => entry.block !== block);
    if (this.entries.length === 0) this.sending = false;
    this.addSent(
      block,
      settled.map((entry) => ({ question: entry.question, text: entry.text })),
    );
    this.commit([block]);
  }

  /** The composer the sheet writes to: the first attached. */
  private composer(): PluginComposerApi | null {
    return this.attached[0]?.composer ?? null;
  }

  /** Answers left staged by an emptied draft that turned out not to be sent: withdrawn. Returns their blocks. */
  private confirmDeletion(): string[] {
    if (!this.sending) return [];
    this.sending = false;
    const blocks = this.entries.map((entry) => entry.block);
    this.entries = [];
    return blocks;
  }

  private addSent(block: string, answers: readonly SentAnswer[]): void {
    const previous = this.sent.has(block) ? this.sent.get(block) : this.storageKey === null ? null : readSent(block);
    const kept = (previous ?? []).filter((item) => !answers.some((answer) => answer.question !== null && answer.question === item.question));
    const next = [...kept, ...answers];
    this.sent.set(block, next);
    if (this.storageKey !== null) writeItem(`${block}:answers`, next);
  }

  /** Writes the answers block, persists, and tells the blocks; `blocks` null: every block changed. */
  private commit(blocks: readonly string[] | null): void {
    this.sync();
    this.persist();
    if (blocks === null) this.snapshots.clear();
    else for (const block of blocks) this.snapshots.delete(block);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private sync(): void {
    const composer = this.composer();
    // While an emptied draft may be the send, the answers are not written back into it.
    if (composer === null || this.sending) return;
    const next = answersText(this.entries);
    if (next === (this.written?.text ?? null)) return;
    try {
      composer.replace((draft) => {
        // Follow the block through what the user typed since the sheet last looked.
        let at: { from: number; to: number } | null = null;
        if (this.written !== null && this.base !== null) {
          const tracked = trackBlock(this.base, draft, this.written);
          if (tracked.kind === "present") at = { from: tracked.from, to: tracked.to };
        }
        const result = writeBlock(draft, at, next);
        if (result === null) {
          this.written = at === null || next === null ? null : { text: next, ...at };
          this.base = this.written === null ? null : draft.text;
          return draft;
        }
        this.written = result.at === null || next === null ? null : { text: next, ...result.at };
        this.base = this.written === null ? null : result.text;
        this.pendingBefore = draft.text;
        return { text: result.text, mentions: result.mentions };
      });
    } catch {
      // The draft is gone (BB says so by throwing): nothing to keep in step.
    }
  }

  private persist(): void {
    if (this.storageKey === null) return;
    const saved: Saved = { entries: this.entries, written: this.written, base: this.base, sending: this.sending };
    writeItem(this.storageKey, saved);
  }
}

const SHEETS = new Map<string, AnswerSheet>();

/** The sheet of thread `threadId`, kept in localStorage. */
export function sheetFor(threadId: string): AnswerSheet {
  let sheet = SHEETS.get(threadId);
  if (sheet === undefined) {
    sheet = new AnswerSheet(`bb.genui.sheet:${threadId}`);
    SHEETS.set(threadId, sheet);
  }
  return sheet;
}

/** The gallery's sheet: nothing persists and no composer takes it; each example shows what it would stage. */
export const GALLERY_SHEET = new AnswerSheet(null);

export function useBlockAnswers(sheet: AnswerSheet, block: string): BlockAnswers {
  return useSyncExternalStore(sheet.subscribe, () => sheet.snapshot(block));
}

/** Answers waiting for a pause in the typing, to write now. */
const PENDING = new Set<() => void>();

/** Writes every answer still waiting for a pause in the typing (a Form's text field), so a send never misses it. */
export function flushAnswers(): void {
  for (const flush of [...PENDING]) flush();
}

function flushOnEnter(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) flushAnswers();
}

function release(run: () => void): void {
  if (!PENDING.delete(run) || PENDING.size > 0) return;
  document.removeEventListener("keydown", flushOnEnter, true);
  document.removeEventListener("pointerdown", flushAnswers, true);
}

/**
 * Registers `flush`, an answer waiting for a pause in the typing; returns
 * its release. While any is pending, Enter anywhere and any press (BB's
 * send button) flush them first, in the capture phase, as does a field
 * losing focus (Form); with none pending, nothing listens.
 */
export function deferAnswer(flush: () => void): () => void {
  if (PENDING.size === 0) {
    document.addEventListener("keydown", flushOnEnter, true);
    document.addEventListener("pointerdown", flushAnswers, true);
  }
  const run = () => {
    release(run);
    flush();
  };
  PENDING.add(run);
  return () => release(run);
}

/**
 * Hands each thread composer on screen to its thread's sheet and lets the
 * sheet read every draft change. Call it where `composers` re-renders with
 * the drafts (useComposers, useComposer). A composer without `replace`
 * (BB before it) takes no answers: its blocks send at once.
 */
export function useAnswerComposers(composers: readonly PluginComposerApi[]): void {
  const threads = composers.flatMap((composer) =>
    composer.scope.kind === "thread" && typeof composer.replace === "function" ? [{ composer, sheet: sheetFor(composer.scope.threadId) }] : [],
  );
  const current = useRef(threads);
  current.current = threads;
  const identity = threads.map(({ composer }) => composer.key).join("\n");
  // Before paint: a block that rendered without the composer must not show its no-composer fallback for a frame.
  useLayoutEffect(() => {
    const detach = current.current.map(({ composer, sheet }) => sheet.attach(composer));
    return () => {
      for (const release of detach) release();
    };
  }, [identity]);
  useEffect(() => {
    for (const { composer, sheet } of threads) sheet.observe(composer);
  });
}
