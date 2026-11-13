import { describe, expect, it } from "vitest";
import type { ComposerDraftSnapshot, ComposerMention } from "@get-bb/plugin-sdk/app";
import {
  findKeywords,
  keywordSelection,
  withoutRanges,
  type KeywordSources,
} from "./setting-keywords";

const sources: KeywordSources = {
  reasoningLevels: new Set(["low", "high", "xhigh"]),
  starredModels: [
    { providerId: "claude-code", model: "claude-opus-5-5", label: "Opus 5.5" },
    { providerId: "codex", model: "gpt-6.1-sol" },
    { providerId: "codex", model: "gpt-6-astra", label: "GPT-6-Astra" },
  ],
};

const draft = (text: string, mentions: ComposerMention[] = []): ComposerDraftSnapshot => ({
  text,
  mentions,
  attachments: [],
});

describe("keywordSelection", () => {
  it("reads permission modes, reasoning levels and starred models", () => {
    expect(keywordSelection("full", sources)).toEqual({ selection: { permissionMode: "full" } });
    expect(keywordSelection("approve", sources)).toEqual({ selection: { permissionMode: "auto" } });
    expect(keywordSelection("XHigh", sources)).toEqual({ selection: { reasoningLevel: "xhigh" } });
    expect(keywordSelection("opus", sources)).toEqual({
      selection: { providerId: "claude-code", model: "claude-opus-5-5" },
    });
    expect(keywordSelection("sol", sources)).toEqual({
      selection: { providerId: "codex", model: "gpt-6.1-sol" },
    });
  });

  it("names no setting for other words and numbers, and refuses an ambiguous model", () => {
    expect(keywordSelection("foo", sources)).toBeNull();
    expect(keywordSelection("5", sources)).toBeNull();
    expect(keywordSelection("gpt", sources)).toEqual({
      error: "#gpt matches more than one starred model.",
    });
  });
});

describe("keywordSelection with a starred model inside another's id", () => {
  const opus = { providerId: "claude-code", model: "claude-opus-5-5" };
  const fable = { providerId: "claude-code", model: "claude-fable-5-2" };
  const stars: KeywordSources = {
    reasoningLevels: new Set(),
    starredModels: [
      { providerId: "codex", model: "gpt-6.1-sol" },
      { providerId: "codex", model: "gpt-6-astra" },
      opus,
      fable,
      { providerId: "devin", model: "fusion-claude-fable-5-2-medium-sidekick-swe-2-flash-max" },
      { providerId: "devin", model: "fusion-claude-opus-5-5-medium-sidekick-swe-2-flash-max" },
    ],
  };
  const labelled: KeywordSources = {
    ...stars,
    starredModels: stars.starredModels.map((entry) => ({
      ...entry,
      label: entry.model.replaceAll("-", " "),
    })),
  };

  it.each([
    ["without display names", stars],
    ["with display names", labelled],
  ])("picks the model the other matches are built on, %s", (_name, sources) => {
    expect(keywordSelection("opus", sources)).toEqual({ selection: opus });
    expect(keywordSelection("fable", sources)).toEqual({ selection: fable });
    expect(keywordSelection("claude-opus-5-5", sources)).toEqual({ selection: opus });
  });

  it("still refuses models that are not built on one another", () => {
    expect(keywordSelection("gpt", stars)).toHaveProperty("error");
    expect(keywordSelection("fusion", stars)).toHaveProperty("error");
    expect(keywordSelection("claude", stars)).toHaveProperty("error");
  });

  it("refuses a shorter id that is not a run of words in the longer one", () => {
    const sources: KeywordSources = {
      reasoningLevels: new Set(),
      starredModels: [
        { providerId: "codex", model: "gpt-6" },
        { providerId: "codex", model: "gpt-6.1-sol" },
        { providerId: "devin", model: "sol-with-gpt-inside-6" },
      ],
    };
    expect(keywordSelection("gpt", sources)).toHaveProperty("error");
  });

  it("refuses the same model starred under two providers", () => {
    const sources: KeywordSources = {
      reasoningLevels: new Set(),
      starredModels: [opus, { providerId: "devin", model: "claude-opus-5-5" }],
    };
    expect(keywordSelection("opus", sources)).toHaveProperty("error");
  });
});

describe("findKeywords", () => {
  it("finds keywords followed by a space, not one still being typed", () => {
    expect(findKeywords(draft("#high fix #foo and #opus now #full"), sources)).toEqual([
      { word: "high", from: 0, to: 5 },
      { word: "opus", from: 19, to: 24 },
    ]);
  });

  it("skips a # inside a word or another mention", () => {
    const mention: ComposerMention = {
      kind: "thread",
      threadId: "t",
      label: "#low",
      from: 0,
      to: 4,
    };
    expect(findKeywords(draft("#low a#high ", [mention]), sources)).toEqual([]);
  });
});

describe("withoutRanges", () => {
  it("removes each keyword with one following space and shifts later mentions", () => {
    const thread: ComposerMention = {
      kind: "thread",
      threadId: "t1",
      label: "x",
      from: 14,
      to: 20,
    };
    expect(
      withoutRanges(draft("Fix #high the @t1abc bug", [thread]), [{ from: 4, to: 9 }]),
    ).toEqual({ text: "Fix the @t1abc bug", mentions: [{ ...thread, from: 8, to: 14 }] });
  });
});
