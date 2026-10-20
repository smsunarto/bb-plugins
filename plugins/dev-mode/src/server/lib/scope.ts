import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@bb-kit/core/tools";
import { files } from "./service.ts";

const names = readdirSync(join(files.root, "skills"));
export function configuration(session: Session) {
  const origin = session.origin.pluginId;
  if (origin === "side-chat") return { tools: [], skills: [] };
  if (origin === "review") return { tools: [], skills: [] };
  if (origin === "scott-engineering") {
    const tools = session.pluginMetadata.reviewRun
      ? ["dev_mode_review_context", "scott_engineering_review_context"]
      : session.pluginMetadata.arena
        ? [
            "dev_mode_arena_context",
            "dev_mode_arena_report",
            "dev_mode_arena_prepare",
            "scott_engineering_arena_context",
            "scott_engineering_arena_report",
            "scott_engineering_arena_prepare",
          ]
        : [];
    return { tools, skills: [] };
  }
  return {
    tools: [
      "dev_mode_arena_start",
      "dev_mode_arena_status",
      "dev_mode_arena_stop",
      "dev_mode_review_start",
      "dev_mode_review_context",
    ],
    skills: names,
    instructions: files.read("review-author"),
  };
}
