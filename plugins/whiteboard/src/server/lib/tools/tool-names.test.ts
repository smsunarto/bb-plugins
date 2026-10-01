import { expect, test } from "vitest";
import { whiteboardCatalog } from "./register.ts";

const names = whiteboardCatalog(false).map((entry) => entry.name);

test("bb registers upstream's 28 tools as whiteboard_session_* and whiteboard_status", () => {
  expect(names).toEqual([
    "whiteboard_session_get_instructions",
    "whiteboard_status",
    "whiteboard_session_capabilities",
    "whiteboard_session_activity",
    "whiteboard_session_delete",
    "whiteboard_session_attention",
    "whiteboard_session_create",
    "whiteboard_session_set_target",
    "whiteboard_session_edit",
    "whiteboard_session_lens_edit",
    "whiteboard_session_rename",
    "whiteboard_session_repin",
    "whiteboard_session_restore",
    "whiteboard_session_list",
    "whiteboard_session_get",
    "whiteboard_session_lens_get",
    "whiteboard_session_history",
    "whiteboard_session_open",
    "whiteboard_session_environment",
    "whiteboard_session_workspace_cleanup",
    "whiteboard_session_register_repository",
    "whiteboard_session_resolve_pins",
    "whiteboard_session_upload",
    "whiteboard_session_source",
    "whiteboard_session_file",
    "whiteboard_session_tree",
    "whiteboard_session_diff",
    "whiteboard_session_commits",
  ]);
});

test("the scratchpad setting never changes a name", () => {
  expect(whiteboardCatalog(true).map((entry) => entry.name)).toEqual(names);
});

test("names fit bb's pattern, avoid its reserved name and fit the 64-char MCP limit", () => {
  // Claude Code sees bb tools as mcp__bb-bridge__<name>; providers cap names at 64.
  const bad = names.filter(
    (name) =>
      !/^[a-zA-Z0-9_-]+$/.test(name) ||
      name === "update_environment_directory" ||
      `mcp__bb-bridge__${name}`.length > 64,
  );
  expect(bad).toEqual([]);
  expect(new Set(names).size).toBe(28);
});
