import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@bb-kit/core/tools";
import type { ArenaContext } from "../command/start.ts";
import { files } from "./service.ts";

const names = readdirSync(join(files.root, "skills"));
export function workerTool(_ctx: ArenaContext, session: Session) {
  return session.origin.pluginId === "scott-engineering";
}
export function authorTool(ctx: ArenaContext, session: Session) {
  return !workerTool(ctx, session) && session.origin.pluginId !== "side-chat";
}
export function skills(ctx: ArenaContext, session: Session) {
  return authorTool(ctx, session) ? names : [];
}
