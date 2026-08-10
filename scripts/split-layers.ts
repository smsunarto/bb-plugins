#!/usr/bin/env bun
/**
 * split-layers — build stacked branches from a snapshot of finished work.
 *
 *   bun scripts/split-layers.ts <manifest.json>
 *
 * The manifest names a snapshot directory holding the FINAL state of every
 * file the split owns, and the layers to build from it, bottom to top:
 *
 *   {
 *     "snapshotDir": "/tmp/split/final",
 *     "branchMode": "gh-stack",            // default; "git" uses checkout -b
 *     "verify": "bun run typecheck",       // optional, runs after each layer
 *     "layers": [
 *       {
 *         "branch": "scott/fix-foo",
 *         "message": "fix(x): subject\n\nBody.",
 *         "files": ["plugins/x/a.ts"],     // copied whole from snapshotDir
 *         "stage": {                       // full INTERMEDIATE states for
 *           "plugins/x/b.ts": "/tmp/split/l1/b.ts"  // files a later layer
 *         }                                // finishes
 *       }
 *     ]
 *   }
 *
 * A file only one layer touches goes in that layer's `files`. A file two
 * layers share gets a full intermediate copy per earlier layer via `stage`,
 * and the last layer lists it in `files` so it ends at the snapshot.
 * Byte-exact copies beat patches and anchored string edits, which drift.
 *
 * The script refuses a dirty tree (stash unrelated work first) and existing
 * layer branches, and after the last layer byte-compares every snapshot file
 * against the working tree. On a mid-run failure it stops in place; delete
 * the branches it created and re-run.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface Layer {
  branch: string;
  message: string;
  files?: string[];
  stage?: Record<string, string>;
}

interface Manifest {
  snapshotDir: string;
  branchMode?: "gh-stack" | "git";
  verify?: string;
  layers: Layer[];
}

function fail(message: string): never {
  console.error(`split-layers: ${message}`);
  process.exit(1);
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8" });
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    fail(
      `\`${command} ${args.join(" ")}\` failed\n${err.stderr ?? ""}${err.stdout ?? ""}`.trim(),
    );
  }
}

function branchExists(branch: string): boolean {
  try {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { encoding: "utf8" },
    );
    return true;
  } catch {
    return false;
  }
}

function snapshotFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).filter((entry) =>
    statSync(join(root, entry)).isFile(),
  );
}

const manifestPath = process.argv[2];
if (!manifestPath) fail("usage: bun scripts/split-layers.ts <manifest.json>");
const manifestDir = dirname(resolve(manifestPath));
const abs = (p: string) => (isAbsolute(p) ? p : resolve(manifestDir, p));

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const snapshotDir = abs(manifest.snapshotDir);
const branchMode = manifest.branchMode ?? "gh-stack";
if (!existsSync(snapshotDir)) fail(`snapshot directory missing: ${snapshotDir}`);
if (!manifest.layers?.length) fail("manifest has no layers");

// ---- Preflight: every failure here happens before any mutation. ----------
const dirty = run("git", ["status", "--porcelain"]).trim();
if (dirty) {
  fail(
    `working tree is dirty — stash work that is not part of this split first:\n${dirty}`,
  );
}
const known = new Set(snapshotFiles(snapshotDir));
if (known.size === 0) fail("snapshot directory holds no files");
for (const layer of manifest.layers) {
  if (!layer.branch || !layer.message) {
    fail(`layer missing branch or message: ${JSON.stringify(layer)}`);
  }
  if (branchExists(layer.branch)) {
    fail(`branch already exists: ${layer.branch}`);
  }
  for (const file of layer.files ?? []) {
    if (!known.has(file)) fail(`${layer.branch}: not in snapshot: ${file}`);
  }
  for (const [target, source] of Object.entries(layer.stage ?? {})) {
    if (!known.has(target)) {
      fail(`${layer.branch}: staged target not in snapshot: ${target}`);
    }
    if (!existsSync(abs(source))) {
      fail(`${layer.branch}: staged source missing: ${source}`);
    }
  }
}
// Every snapshot file must land somewhere, or the top cannot match it.
const assigned = new Set(manifest.layers.flatMap((layer) => layer.files ?? []));
const unassigned = [...known].filter((file) => !assigned.has(file));
if (unassigned.length > 0) {
  fail(
    `snapshot files no layer lists in \`files\` (each must reach its final state):\n  ${unassigned.join("\n  ")}`,
  );
}

// ---- Build, bottom to top. -----------------------------------------------
if (branchMode === "gh-stack") run("gh", ["stack", "top"]);
for (const layer of manifest.layers) {
  console.log(`\n== ${layer.branch}`);
  if (branchMode === "gh-stack") run("gh", ["stack", "add", layer.branch]);
  else run("git", ["checkout", "-b", layer.branch]);

  for (const file of layer.files ?? []) {
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(snapshotDir, file), file);
  }
  for (const [target, source] of Object.entries(layer.stage ?? {})) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(abs(source), target);
  }

  if (!run("git", ["status", "--porcelain"]).trim()) {
    fail(`${layer.branch}: layer changes nothing`);
  }
  if (manifest.verify) {
    try {
      execFileSync("sh", ["-c", manifest.verify], { stdio: "inherit" });
    } catch {
      fail(`${layer.branch}: verify failed: ${manifest.verify}`);
    }
  }
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", layer.message]);
  console.log(`   committed ${run("git", ["rev-parse", "--short", "HEAD"]).trim()}`);
}

// ---- Prove the top matches the snapshot, byte for byte. ------------------
let mismatched = 0;
for (const file of known) {
  const finished = readFileSync(join(snapshotDir, file));
  const inTree = existsSync(file) ? readFileSync(file) : null;
  if (inTree === null || !finished.equals(inTree)) {
    console.error(`DIFF  ${file}`);
    mismatched++;
  }
}
if (mismatched > 0) fail(`${mismatched} file(s) differ from the snapshot`);
console.log(`\nOK — top of stack matches the snapshot (${known.size} files)`);
