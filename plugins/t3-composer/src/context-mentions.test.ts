import { describe, expect, it } from "vitest";
import type { ComposerMention } from "@get-bb/plugin-sdk/app";
import { groupContextMentions, withoutMentions } from "./context-mentions";

const annotation = (id: string, from: number): ComposerMention => ({
  kind: "plugin",
  pluginId: "agentation",
  provider: "annotation",
  id,
  label: `Annotation ${id}`,
  from,
  to: from + 1,
});

describe("context mentions", () => {
  it("counts annotations per plugin and leaves other mentions in the text", () => {
    const groups = groupContextMentions([
      annotation("a", 4),
      { kind: "project", projectId: "p", label: "bb", from: 0, to: 1 },
      annotation("b", 6),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["2 annotations"]);
  });

  it("removes mention text and shifts later mentions", () => {
    const draft = {
      text: "fix ￼ and ￼ now",
      mentions: [
        annotation("a", 4),
        { kind: "project", projectId: "p", label: "bb", from: 10, to: 11 } as ComposerMention,
      ],
    };
    const next = withoutMentions(draft, (mention) => mention.kind === "plugin");
    expect(next.text).toBe("fix and ￼ now");
    expect(next.mentions).toEqual([{ ...draft.mentions[1], from: 8, to: 9 }]);
  });

  it("empties a draft left with only separators", () => {
    const draft = { text: " ￼ ", mentions: [annotation("a", 1)] };
    expect(withoutMentions(draft, () => true)).toEqual({ text: "", mentions: [] });
  });
});
