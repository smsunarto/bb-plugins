#!/usr/bin/env node
import process from "node:process";
import { runAdd } from "./add.ts";
import { runCheck } from "./check.ts";
import { runCreate } from "./create.ts";
import type { BinResult } from "./shared.ts";

// TS 7's sync API reads `child.stdout._handle.fd`, a Node internal
// absent in Bun, so a bun-run `check` fails and then hangs on the
// orphaned compiler child. Refuse before any command can spawn it.
if (process.versions["bun"] !== undefined) {
  process.stderr.write(
    "bb-kit must run under node, not bun — use the `bb-kit` bin or `node --import tsx packages/bb-kit-core/src/bin/bin.ts <command>` (TS 7's sync toolchain reads Node internals absent in Bun)\n",
  );
  process.exit(1);
}

/**
 * The bb-kit bin (§7): `create <name>`, `add <kind> <name>`, `check`.
 * Dispatch only — every command lives in its own module and returns a
 * BinResult, so tests drive the commands without executing this file.
 * Usage mistakes exit 2; command failures exit 1.
 */

const USAGE = [
  "usage:",
  "  bb-kit create <package-name>        scaffold a new plugin directory",
  "  bb-kit add <query|mutation|command> <kebab-name>",
  "                                      generate one unit + sibling test",
  "  bb-kit check                        verify wiring, naming, and manifest",
  "",
].join("\n");

function usageError(message: string): BinResult {
  return { exitCode: 2, stdout: "", stderr: `${message}\n\n${USAGE}` };
}

async function main(argv: readonly string[]): Promise<BinResult> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    return { exitCode: command === undefined ? 2 : 0, stdout: USAGE, stderr: "" };
  }
  if (command === "create") {
    const [name] = rest;
    if (name === undefined || rest.length !== 1) {
      return usageError("create takes exactly one argument: the package name");
    }
    return runCreate(name, { cwd: process.cwd() });
  }
  if (command === "add") {
    const [kind, name] = rest;
    if (kind === undefined || name === undefined || rest.length !== 2) {
      return usageError("add takes exactly two arguments: a kind and a kebab-case name");
    }
    return runAdd(kind, name, { cwd: process.cwd() });
  }
  if (command === "check") {
    if (rest.length !== 0) {
      return usageError("check takes no arguments — run it at the plugin root");
    }
    return runCheck({ cwd: process.cwd() });
  }
  return usageError(`unknown command "${command}"`);
}

const result = await main(process.argv.slice(2));
const flush = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
  new Promise((resolve) => {
    if (text === "") {
      resolve();
      return;
    }
    stream.write(text, () => resolve());
  });
await Promise.all([flush(process.stdout, result.stdout), flush(process.stderr, result.stderr)]);
if (result.exitCode !== 0) {
  // A failed run can leave TS 7's spawned compiler service holding the
  // event loop open (close() is best-effort on the failure paths), so a
  // red result exits explicitly once its output has flushed.
  process.exit(result.exitCode);
}
process.exitCode = result.exitCode;
