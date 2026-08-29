import { spawnSync } from "node:child_process";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const packed = spawnSync("bun", ["pm", "pack", "--dry-run"], {
  cwd: pluginRoot,
  encoding: "utf8",
});
const output = `${packed.stdout ?? ""}${packed.stderr ?? ""}`;
if (packed.status !== 0) {
  process.stderr.write(output);
  process.exit(packed.status ?? 1);
}

const required = [
  "dist/monaco/editor.js",
  "dist/monaco/editor.css",
  "dist/monaco/editor.worker.js",
];
const missing = required.filter((name) => !output.includes(name));
if (missing.length > 0) {
  throw new Error(`packed Dotfiles plugin is missing: ${missing.join(", ")}`);
}
console.log(`package: includes ${required.join(", ")}`);
