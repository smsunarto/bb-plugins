import { describe, expect, it } from "vitest";
import type { ComposerMention } from "@get-bb/plugin-sdk/app";
import {
  HANDOFF_COMMAND,
  hasHandoffBlock,
  handoffGroupFor,
  isHandoffCommand,
  withoutHandoffRemnant,
  withoutLeadingHandoff,
} from "./handoff-command";

function fileMention(from: number, to: number): ComposerMention {
  return { kind: "path", path: "src/app.ts", from, to, label: "app.ts" } as ComposerMention;
}

describe("handoffGroupFor", () => {
  it("offers /handoff for a bare slash and its prefixes, in any case", () => {
    for (const text of ["", "h", "hand", "HandOff"]) {
      expect(handoffGroupFor({ char: "/", text })?.suggestions).toEqual([HANDOFF_COMMAND]);
    }
  });

  it("offers nothing for another query, another trigger, or no menu", () => {
    expect(handoffGroupFor({ char: "/", text: "handoffs" })).toBeNull();
    expect(handoffGroupFor({ char: "/", text: "review" })).toBeNull();
    expect(handoffGroupFor({ char: "$", text: "handoff" })).toBeNull();
    expect(handoffGroupFor(null)).toBeNull();
  });
});

describe("isHandoffCommand", () => {
  it("tells this composer's command from a provider's own command named handoff", () => {
    expect(isHandoffCommand(HANDOFF_COMMAND)).toBe(true);
    expect(isHandoffCommand({ ...HANDOFF_COMMAND, pluginId: undefined, origin: "user" })).toBe(
      false,
    );
  });
});

describe("withoutLeadingHandoff", () => {
  it("strips a typed /handoff and keeps the rest of the draft, mentions shifted", () => {
    expect(
      withoutLeadingHandoff({ text: "/handoff  fix @app.ts", mentions: [fileMention(14, 21)] }),
    ).toEqual({ text: "fix @app.ts", mentions: [fileMention(4, 11)] });
    expect(withoutLeadingHandoff({ text: "/handoff", mentions: [] })).toEqual({
      text: "",
      mentions: [],
    });
  });

  it("leaves other drafts alone", () => {
    expect(withoutLeadingHandoff({ text: "/handoffs", mentions: [] })).toBeNull();
    expect(withoutLeadingHandoff({ text: "please /handoff", mentions: [] })).toBeNull();
  });

  it("leaves a /handoff pill, another command picked from the menu, for the agent", () => {
    const pill = { kind: "command", from: 0, to: 8, label: "handoff" } as ComposerMention;
    expect(withoutLeadingHandoff({ text: "/handoff", mentions: [pill] })).toBeNull();
  });
});

describe("hasHandoffBlock", () => {
  const pill = (threadId: string) =>
    ({ kind: "thread", threadId, from: 14, to: 35, label: "Source" }) as ComposerMention;

  it("finds the pill of the thread being handed off from", () => {
    expect(hasHandoffBlock([fileMention(0, 4), pill("thr_source")], "thr_source")).toBe(true);
  });

  it("reports the block gone once that pill is deleted, whatever else remains", () => {
    expect(hasHandoffBlock([fileMention(0, 4), pill("thr_other")], "thr_source")).toBe(false);
    expect(hasHandoffBlock([], "thr_source")).toBe(false);
  });
});

describe("withoutHandoffRemnant", () => {
  it("drops the text BB's block leaves behind its deleted pill, keeping what follows", () => {
    expect(
      withoutHandoffRemnant({
        text: "Continue from \n\nfix @app.ts",
        mentions: [fileMention(20, 27)],
      }),
    ).toEqual({ text: "fix @app.ts", mentions: [fileMention(4, 11)] });
    expect(withoutHandoffRemnant({ text: "Continue from ", mentions: [] })).toEqual({
      text: "",
      mentions: [],
    });
  });

  it("leaves a draft the user has already rewritten alone", () => {
    expect(withoutHandoffRemnant({ text: "Continue the work", mentions: [] })).toBeNull();
  });
});
