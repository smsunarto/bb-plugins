/**
 * Release Please's released paths, as a JSON array argument, filtered to the
 * packages npm publishes. Tag-only plugins (private, listed in
 * marketplace.json) are released as tags and GitHub Releases only.
 *
 *   bun scripts/release-npm-paths.ts '["plugins/amp","plugins/source-control"]'
 *   → ["plugins/amp"]
 */
import { fileURLToPath } from "node:url";
import { npmPublishPaths } from "./plugin-package";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const paths = JSON.parse(process.argv[2] ?? "[]") as unknown;
if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
  console.error("expected a JSON array of package paths");
  process.exit(1);
}
console.log(JSON.stringify(npmPublishPaths(ROOT, paths)));
