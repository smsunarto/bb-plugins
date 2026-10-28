import { describe, expect, it } from "vitest";
import { answersText, orderEntries, sameBlock, trackBlock, writeBlock, type StagedEntry, type Tracked, type WrittenBlock } from "./answers";

function entry(text: string, at: Partial<StagedEntry> = {}): StagedEntry {
  return { message: "m1", reply: 3, fence: 0, position: 0, seq: 0, text, ...at };
}

const mention = (from: number, to: number, label: string) => ({ from, to, label, kind: "thread" as const, threadId: label });

describe("answer order", () => {
  it("reads answers in reply order: message, then fence, then place in the block, whatever order they were picked in", () => {
    const entries = [
      entry("second fence", { fence: 1, position: 0, seq: 0 }),
      entry("later reply", { message: "m2", reply: 5, seq: 1 }),
      entry("first fence, below", { fence: 0, position: 2, seq: 2 }),
      entry("first fence, above", { fence: 0, position: 1, seq: 3 }),
    ];
    expect(answersText(entries)).toBe("first fence, above\nfirst fence, below\nsecond fence\nlater reply");
  });

  it("orders replies the thread outline hasn't listed yet by when their first answer was staged", () => {
    const entries = [entry("b", { message: "b", reply: null, seq: 4 }), entry("a", { message: "a", reply: null, seq: 2 }), entry("a2", { message: "a", reply: null, fence: 1, seq: 9 })];
    expect(orderEntries(entries).map((item) => item.text)).toEqual(["a", "a2", "b"]);
  });

  it("writes a Form's lines as they are and has no block for no answers", () => {
    expect(answersText([entry("Pro"), entry("Name: Ada\nSize: M", { position: 1 })])).toBe("Pro\nName: Ada\nSize: M");
    expect(answersText([])).toBeNull();
    expect(answersText([entry("  ")])).toBeNull();
  });
});

/** The user types `typed` one key at a time at `at`, as the sheet sees the draft between keys. */
function typeAt(start: string, at: number, typed: string, block: WrittenBlock): { text: string; block: WrittenBlock | null } {
  let text = start;
  let current: WrittenBlock | null = block;
  for (const [index, key] of [...typed].entries()) {
    const next = `${text.slice(0, at + index)}${key}${text.slice(at + index)}`;
    const tracked: Tracked = current === null ? { kind: "edited" } : trackBlock(text, { text: next, mentions: [] }, current);
    current = tracked.kind === "present" && current !== null ? { text: current.text, from: tracked.from, to: tracked.to } : null;
    text = next;
  }
  return { text, block: current };
}

const written = (text: string, from: number): WrittenBlock => ({ text, from, to: from + text.length });

describe("writing the answers block", () => {
  it("appends the first block as its own paragraph after what the user wrote, leaving their mentions", () => {
    const draft = { text: "Thanks, @Sam", mentions: [mention(8, 12, "@Sam")] };
    expect(writeBlock(draft, null, "Pro")).toEqual({ text: "Thanks, @Sam\n\nPro", mentions: [mention(8, 12, "@Sam")], at: { from: 14, to: 17 } });
    expect(writeBlock({ text: "Hi\n", mentions: [] }, null, "Pro")?.text).toBe("Hi\n\nPro");
    expect(writeBlock({ text: "Hi\n\n", mentions: [] }, null, "Pro")?.text).toBe("Hi\n\nPro");
    expect(writeBlock({ text: "", mentions: [] }, null, "Pro")).toEqual({ text: "Pro", mentions: [], at: { from: 0, to: 3 } });
    expect(writeBlock({ text: " \n", mentions: [] }, null, "Pro")?.text).toBe("Pro");
  });

  it("replaces the block in place, keeps the user's text on both sides, and moves the mentions after it", () => {
    const text = "Before @Ana\n\nPro\nName: Ada\n\nAfter @Sam";
    const draft = { text, mentions: [mention(7, 11, "@Ana"), mention(34, 38, "@Sam")] };
    const spliced = writeBlock(draft, { from: 13, to: 26 }, "Pro\nName: Ada Lovelace")!;
    expect(spliced.text).toBe("Before @Ana\n\nPro\nName: Ada Lovelace\n\nAfter @Sam");
    expect(spliced.mentions).toEqual([mention(7, 11, "@Ana"), mention(43, 47, "@Sam")]);
    expect(spliced.at).toEqual({ from: 13, to: 35 });
    // The rebased range still covers the pill's label.
    expect(spliced.text.slice(43, 47)).toBe("@Sam");
  });

  it("takes an emptied block out with its paragraph break", () => {
    expect(writeBlock({ text: "Hi\n\nPro", mentions: [] }, { from: 4, to: 7 }, null)).toEqual({ text: "Hi", mentions: [], at: null });
    expect(writeBlock({ text: "Pro\n\nHi", mentions: [] }, { from: 0, to: 3 }, null)?.text).toBe("Hi");
    expect(writeBlock({ text: "Hi\n\nPro\n\nBye", mentions: [] }, { from: 4, to: 7 }, null)?.text).toBe("Hi\n\nBye");
    expect(writeBlock({ text: "Pro", mentions: [] }, { from: 0, to: 3 }, null)?.text).toBe("");
    const after = writeBlock({ text: "Hi\n\nPro\n\n@Sam", mentions: [mention(9, 13, "@Sam")] }, { from: 4, to: 7 }, null)!;
    expect(after).toEqual({ text: "Hi\n\n@Sam", mentions: [mention(4, 8, "@Sam")], at: null });
  });

  it("writes nothing when the block is unchanged, or there is no block and nothing is staged", () => {
    expect(writeBlock({ text: "Hi\n\nPro", mentions: [] }, { from: 4, to: 7 }, "Pro")).toBeNull();
    expect(writeBlock({ text: "Hi", mentions: [] }, null, null)).toBeNull();
  });
});

describe("following the block through the user's edits", () => {
  it("keeps the block the sheet wrote when the user types the same answer after it, so a switch replaces only its own", () => {
    // Staged "Pro"; the user types a paragraph that also reads "Pro".
    const typed = typeAt("Pro", 3, "\n\nPro", written("Pro", 0));
    expect(typed).toEqual({ text: "Pro\n\nPro", block: written("Pro", 0) });
    // Switching to Basic rewrites the sheet's line, not the user's.
    expect(writeBlock({ text: typed.text, mentions: [] }, typed.block, "Basic")?.text).toBe("Basic\n\nPro");
    // The same in a paragraph the user opens above it: the block moves along.
    const before = typeAt("Hi\n\nPro", 3, "\nPro\n", written("Pro", 4));
    expect(before).toEqual({ text: "Hi\n\nPro\n\nPro", block: written("Pro", 9) });
    expect(writeBlock({ text: before.text, mentions: [] }, before.block, "Basic")?.text).toBe("Hi\n\nPro\n\nBasic");
    // Typing onto the block's own line makes it the user's.
    expect(typeAt("Pro", 0, "X", written("Pro", 0)).block).toBeNull();
  });

  it("leaves the draft alone when a change could be aligned either side of the block (a paste of the same text)", () => {
    expect(trackBlock("Pro", { text: "Pro\n\nPro", mentions: [] }, written("Pro", 0))).toEqual({ kind: "edited" });
  });

  it("moves the block with text typed or deleted beside it, and keeps mentions after it intact", () => {
    expect(trackBlock("Hi\n\nPro", { text: "Hi there\n\nPro", mentions: [] }, written("Pro", 4))).toEqual({ kind: "present", from: 10, to: 13 });
    expect(trackBlock("Hi\n\nPro", { text: "\n\nPro", mentions: [] }, written("Pro", 4))).toEqual({ kind: "present", from: 2, to: 5 });
  });

  it("hands the block to the user when they type into it or join a line to it", () => {
    expect(trackBlock("Hi\n\nPro", { text: "Hi\n\nPro, unless SSO", mentions: [] }, written("Pro", 4))).toEqual({ kind: "edited" });
    expect(trackBlock("Hi\n\nPro", { text: "Hi\n\nXPro", mentions: [] }, written("Pro", 4))).toEqual({ kind: "edited" });
    expect(trackBlock("Hi\n\nPro", { text: "HiPro", mentions: [] }, written("Pro", 4))).toEqual({ kind: "edited" });
    // The text unchanged, but a mention pill now lies over the block: it is the user's.
    expect(trackBlock("Hi\n\nPro", { text: "Hi\n\nPro", mentions: [mention(4, 7, "Pro")] }, written("Pro", 4))).toEqual({ kind: "edited" });
    expect(trackBlock("Hi\n\nPro\n", { text: "Hi\n\nPro\n@S", mentions: [mention(8, 10, "@S")] }, written("Pro", 4))).toEqual({ kind: "present", from: 4, to: 7 });
  });

  it("deletes it when a change takes the whole block out, but not when part of it is left", () => {
    const block = written("Pro\nName: Ada", 4);
    expect(trackBlock("Hi\n\nPro\nName: Ada", { text: "Hi", mentions: [] }, block)).toEqual({ kind: "deleted" });
    expect(trackBlock("Hi\n\nPro\nName: Ada", { text: "", mentions: [] }, block)).toEqual({ kind: "deleted" });
    expect(trackBlock("Hi\n\nPro\nName: Ada", { text: "Hi\n\nPro\nName: Ada L.", mentions: [] }, block)).toEqual({ kind: "edited" });
    expect(trackBlock("Hi\n\nPro\nName: Ada", { text: "Hi\n\nPro", mentions: [] }, block)).toEqual({ kind: "edited" });
  });

  it("keeps a block whose line breaks the editor widened, and a TextArea answer's own blank line", () => {
    const block = written("Pro\nNotes: first\n\nsecond", 4);
    const before = "Hi\n\nPro\nNotes: first\n\nsecond\n\nBye";
    // Unchanged: the blank line inside the answer is the block's own.
    expect(trackBlock(before, { text: before, mentions: [] }, block)).toEqual({ kind: "present", from: 4, to: 28 });
    // Paragraphs read back further apart.
    const widened = "Hi\n\nPro\n\nNotes: first\n\n\nsecond\n\nBye";
    expect(trackBlock(before, { text: widened, mentions: [] }, block)).toEqual({ kind: "present", from: 4, to: 30 });
    // Ownership holds through later edits beside the widened block, and a switch rewrites it as one block.
    const accepted = { text: block.text, from: 4, to: 30 };
    const typedBefore = `Hi there${widened.slice(2)}`;
    const movedBefore = trackBlock(widened, { text: typedBefore, mentions: [] }, accepted);
    expect(movedBefore).toEqual({ kind: "present", from: 10, to: 36 });
    const typedAfter = `${typedBefore}!`;
    expect(trackBlock(typedBefore, { text: typedAfter, mentions: [] }, { ...accepted, from: 10, to: 36 })).toEqual({ kind: "present", from: 10, to: 36 });
    expect(writeBlock({ text: typedAfter, mentions: [] }, { from: 10, to: 36 }, "Basic\nNotes: first\n\nsecond")?.text).toBe("Hi there\n\nBasic\nNotes: first\n\nsecond\n\nBye!");
    // A line break it needs, gone: no longer the block.
    expect(trackBlock(before, { text: "Hi\n\nPro\nNotes: first\nsecond\n\nBye", mentions: [] }, block)).toEqual({ kind: "edited" });
    expect(sameBlock("Pro\n\nNotes: first\n\n\nsecond", "Pro\nNotes: first\n\nsecond")).toBe(true);
    expect(sameBlock("Pro\nNotes: first\nsecond", "Pro\nNotes: first\n\nsecond")).toBe(false);
  });
});
