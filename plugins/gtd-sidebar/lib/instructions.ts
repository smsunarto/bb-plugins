import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The server runs from src/ under `bb plugin dev` and from dist/ once installed,
// so resolve the plugin root instead of hardcoding a relative path.
function pluginRoot(): string {
  let dir = import.meta.dirname;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("gtd-sidebar: plugin root not found");
    dir = parent;
  }
  return dir;
}

export function readInstructions(name: string): string {
  return readFileSync(join(pluginRoot(), "instructions", `${name}.md`), "utf8").trim();
}
