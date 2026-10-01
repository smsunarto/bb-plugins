import { describe, expect, test } from "vitest";
import {
  bbToolName,
  renameSchemaDescriptions,
  renameToolTokens,
  SESSION_TOOL_SUFFIXES,
} from "./rename.ts";

describe("renameToolTokens", () => {
  test("prefixes every catalog token in prose", () => {
    expect(
      renameToolTokens(
        'Call session_get_instructions({topic:"scratchpad"}), then session_get. Fix with session_edit.',
      ),
    ).toBe(
      'Call whiteboard_session_get_instructions({topic:"scratchpad"}), then whiteboard_session_get. Fix with whiteboard_session_edit.',
    );
  });

  test("matches the longest tool name, not a prefix of it", () => {
    expect(renameToolTokens("session_lens_get and session_lens_edit and session_get")).toBe(
      "whiteboard_session_lens_get and whiteboard_session_lens_edit and whiteboard_session_get",
    );
  });

  test("is idempotent", () => {
    const once = renameToolTokens("Read it with session_get first.");
    expect(once).toBe("Read it with whiteboard_session_get first.");
    expect(renameToolTokens(once)).toBe(once);
  });

  test("leaves words that are not catalog tools alone", () => {
    expect(
      renameToolTokens(
        "session_id, session_getter, my_session_get, review_open, whiteboard_status, sessionId",
      ),
    ).toBe("session_id, session_getter, my_session_get, review_open, whiteboard_status, sessionId");
  });
});

describe("bbToolName", () => {
  test("prefixes session tools and keeps whiteboard_status", () => {
    expect(bbToolName("session_get")).toBe("whiteboard_session_get");
    expect(bbToolName("whiteboard_status")).toBe("whiteboard_status");
    expect(bbToolName("whiteboard_session_get")).toBe("whiteboard_session_get");
  });
});

test("the suffixes are upstream's 27 session tools, longest first", () => {
  expect(SESSION_TOOL_SUFFIXES).toEqual([
    "register_repository",
    "workspace_cleanup",
    "get_instructions",
    "capabilities",
    "resolve_pins",
    "environment",
    "set_target",
    "attention",
    "lens_edit",
    "activity",
    "lens_get",
    "commits",
    "history",
    "restore",
    "create",
    "delete",
    "rename",
    "source",
    "upload",
    "repin",
    "diff",
    "edit",
    "file",
    "list",
    "open",
    "tree",
    "get",
  ]);
});

describe("renameSchemaDescriptions", () => {
  test("renames description prose at any depth and keeps data keys and property names", () => {
    expect(
      renameSchemaDescriptions({
        type: "object",
        description: "See session_get.",
        properties: {
          session_get: { type: "string", description: "Like session_list." },
          mode: {
            enum: ["session_get"],
            const: "session_get",
            default: "session_get",
            examples: ["session_get"],
          },
        },
        anyOf: [{ description: "Use session_edit." }],
      }),
    ).toEqual({
      type: "object",
      description: "See whiteboard_session_get.",
      properties: {
        session_get: { type: "string", description: "Like whiteboard_session_list." },
        mode: {
          enum: ["session_get"],
          const: "session_get",
          default: "session_get",
          examples: ["session_get"],
        },
      },
      anyOf: [{ description: "Use whiteboard_session_edit." }],
    });
  });

  test("keeps a property named description", () => {
    expect(
      renameSchemaDescriptions({
        properties: { description: { type: "string", description: "session_get" } },
      }),
    ).toEqual({
      properties: { description: { type: "string", description: "whiteboard_session_get" } },
    });
  });
});
