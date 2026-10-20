import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@bb-kit/core/tools";
import { files } from "./service.ts";
import { authorInstructions } from "./review.ts";

const names = readdirSync(join(files.root, "skills"));
export function configuration(session: Session) {
  const origin = session.origin.pluginId;
  if (origin === "side-chat") return { tools: [], skills: [] };
  if (origin === "review") return { tools: [], skills: [] };
  if (origin === "scott-engineering") {
    const tools = session.pluginMetadata.reviewRun
      ? ["scott_engineering_review_context"]
      : session.pluginMetadata.arena
        ? [
            "scott_engineering_arena_context",
            "scott_engineering_arena_report",
            "scott_engineering_arena_prepare",
          ]
        : [];
    return { tools, skills: [] };
  }
  return {
    tools: [
      "scott_engineering_arena_start",
      "scott_engineering_arena_status",
      "scott_engineering_arena_stop",
      "scott_engineering_review_start",
      "scott_engineering_review_result",
      "scott_engineering_review_context",
    ],
    skills: names,
    instructions: authorInstructions(),
  };
}
