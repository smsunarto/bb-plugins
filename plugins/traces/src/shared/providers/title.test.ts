import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ParsedRecord, TraceAdapter } from "../model";
import { builtinAdapters } from "./index";

const recommended =
  "<recommended_plugins>\nAvailable but not installed:\n- Example (example@plugins)\n</recommended_plugins>";
const instructions =
  "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nUse the formatter.\n</INSTRUCTIONS>";
const environment =
  "<environment_context>\n<cwd>/repo</cwd>\n<shell>zsh</shell>\n</environment_context>";
const catalogs =
  "## Available skills\n- review: Review the change.\n  Run scoped checks.\n\n## Available plugins\n- example: An available plugin.";

function userRecord(adapter: TraceAdapter, content: unknown): unknown {
  return adapter.id === "claude-code"
    ? { type: "user", message: { role: "user", content } }
    : { type: "response_item", payload: { type: "message", role: "user", content } };
}

function parse(adapter: TraceAdapter, content: unknown): ParsedRecord {
  return adapter.parse(userRecord(adapter, content), { path: "/fixture.jsonl", line: 1 });
}

for (const adapter of builtinAdapters) {
  describe(`${adapter.label} prompt titles`, () => {
    it("leaves metadata-only records untitled so a later user prompt can supply the title", () => {
      const metadata = [recommended, instructions, environment, catalogs];
      for (const content of [...metadata, metadata.join("\n\n")]) {
        const parsed = parse(adapter, content);
        assert.equal(parsed.session.title, undefined);
        assert.ok(parsed.events.length > 0);
      }
      assert.equal(
        parse(adapter, "Fix the checkout validation").session.title,
        "Fix the checkout validation",
      );
    });

    it("extracts the real prompt after combined injected prefixes without changing recorded content", () => {
      const content = `${recommended}\n${instructions}\n${environment}\n\nBuild a trace explorer\nKeep navigation fast.`;
      const parsed = parse(adapter, content);
      assert.equal(parsed.session.title, "Build a trace explorer");
      assert.ok(
        parsed.events.some(({ body }) =>
          body.type === "text"
            ? body.text === content
            : body.type === "context" && body.content === content,
        ),
      );
    });

    it("finds the prompt after context spread across text blocks and beyond the preview limit", () => {
      const prefix = `<recommended_plugins>\n${"Catalog entry\n".repeat(300)}\n</recommended_plugins>`;
      const blocks = [
        prefix,
        instructions,
        environment,
        "\n\nImprove checkout errors\nThen run tests.",
      ].map((text) => ({ type: "text", text }));
      const parsed = parse(adapter, blocks);
      assert.equal(parsed.session.title, "Improve checkout errors");
      assert.equal(parsed.events.length, blocks.length);
      const first = parsed.events[0]?.body;
      assert.equal(first?.type, "text");
      if (first?.type === "text") assert.equal(first.text, prefix);
    });

    it("skips nested instruction envelopes and structured catalogs before the prompt", () => {
      const nested =
        "<INSTRUCTIONS>\nOuter instructions\n<INSTRUCTIONS>Nested example</INSTRUCTIONS>\n</INSTRUCTIONS>";
      const reminder = "<system-reminder>Recorded context</system-reminder>";
      const content = `${nested}\n${reminder}\n${catalogs}\n\nFix the checkout button`;
      assert.equal(parse(adapter, content).session.title, "Fix the checkout button");
    });

    it("preserves ordinary prompts mentioning plugins and instruction markup", () => {
      const prompts = [
        "Recommend plugins for a trace viewer",
        "Which recommended plugins should I install?",
        "Explain how <recommended_plugins> works",
        "<recommended_plugins> is a literal token I am asking about",
        "# AGENTS.md instructions for /repo\nPlease explain this header",
        "## Available plugins\nWhich one should I use?",
        "```xml\n<environment_context>Example</environment_context>\n```",
        "Find useful plugins\n<recommended_plugins>Example</recommended_plugins>",
      ];
      for (const prompt of prompts)
        assert.equal(parse(adapter, prompt).session.title, prompt.split("\n")[0]);
    });

    it("does not derive a title from tool result bodies or image metadata", () => {
      const parsed = parse(adapter, [
        { type: "tool_result", content: "Tool output is not a user prompt", tool_use_id: "tool" },
        { type: "image", source: { type: "base64", data: "Image metadata is not a user prompt" } },
      ]);
      assert.equal(parsed.session.title, undefined);
    });
  });
}

it("uses the same prompt extraction for Codex user-message notifications", () => {
  const codex = builtinAdapters.find((adapter) => adapter.id === "codex")!;
  for (const [message, title] of [
    [recommended, undefined],
    [`${recommended}\n${environment}\nExplain the failing test`, "Explain the failing test"],
  ] as const) {
    const parsed = codex.parse(
      { type: "event_msg", payload: { type: "user_message", message } },
      { path: "/fixture.jsonl", line: 1 },
    );
    assert.equal(parsed.session.title, title);
  }
});

it("preserves explicit Claude titles and caps extracted titles", () => {
  const claude = builtinAdapters.find((adapter) => adapter.id === "claude-code")!;
  const parsed = claude.parse(
    { type: "custom-title", customTitle: "<recommended_plugins> investigation" },
    { path: "/fixture.jsonl", line: 1 },
  );
  assert.equal(parsed.session.title, "<recommended_plugins> investigation");
  for (const adapter of builtinAdapters)
    assert.equal(parse(adapter, "x".repeat(200)).session.title?.length, 160);
});
