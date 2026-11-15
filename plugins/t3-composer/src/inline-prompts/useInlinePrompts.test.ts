import { describe, expect, it } from "vitest";
import { inlinePromptMentionTarget } from "./useInlinePrompts";

const names = new Set(["abstract"]);

describe("inlinePromptMentionTarget", () => {
  it("turns a user skill marked inline into this plugin's prompt pill", () => {
    expect(
      inlinePromptMentionTarget({ name: "abstract", source: "skill", origin: "user" }, names),
    ).toEqual({
      kind: "plugin",
      pluginId: "t3-composer",
      provider: "inline-prompts",
      id: "abstract",
      icon: "Zap",
      label: "abstract",
    });
  });

  it("keeps the skill pill for other skills, project skills and commands", () => {
    expect(
      inlinePromptMentionTarget({ name: "dev", source: "skill", origin: "user" }, names),
    ).toBeNull();
    expect(
      inlinePromptMentionTarget({ name: "abstract", source: "skill", origin: "project" }, names),
    ).toBeNull();
    expect(
      inlinePromptMentionTarget({ name: "abstract", source: "command", origin: "user" }, names),
    ).toBeNull();
  });
});
