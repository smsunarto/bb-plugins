import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BinResult } from "./bin-shared.ts";
import { scaffoldFiles } from "./scaffold.ts";

/**
 * `bb-kit create <name>` (§7): scaffold a complete, working plugin into
 * a NEW directory (the package name minus any npm scope), install its
 * devDependencies, and print the derived plugin id. Refuses to touch an
 * existing non-empty directory — create never edits (ADR-0009).
 */

export type InstallOutcome = { status: number; output: string };
export type CreateOptions = {
  cwd: string;
  /** Injectable for tests; defaults to a real `npm install`. */
  install?: (dir: string) => InstallOutcome;
};

/**
 * npm's registry occasionally answers 5xx (the E502 lore) — those and
 * plain network drops are worth up to three attempts before giving up.
 */
const TRANSIENT_NPM_FAILURE =
  /E5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i;

function npmInstall(dir: string): InstallOutcome {
  const run = spawnSync("npm", ["install"], { cwd: dir, encoding: "utf8" });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.error) {
    return { status: 1, output: `${output}${run.error.message}\n` };
  }
  return { status: run.status ?? 1, output };
}

export function runCreate(name: string, options: CreateOptions): BinResult {
  let scaffold: ReturnType<typeof scaffoldFiles>;
  try {
    scaffold = scaffoldFiles(name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `${message}\n` };
  }

  const dirName = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  if (dirName === "") {
    return { exitCode: 1, stdout: "", stderr: `"${name}" is not a usable package name\n` };
  }
  const dir = resolve(options.cwd, dirName);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `refusing to scaffold into ${dirName}/ — it exists and is not empty (create never edits)\n`,
    };
  }

  for (const [relativePath, content] of Object.entries(scaffold.files)) {
    const target = join(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  let stdout = `created ${dirName}/ (plugin id: ${scaffold.id})\n`;
  for (const relativePath of Object.keys(scaffold.files)) {
    stdout += `  ${relativePath}\n`;
  }

  stdout += "\ninstalling devDependencies (npm install)...\n";
  const install = options.install ?? npmInstall;
  let outcome: InstallOutcome = { status: 1, output: "" };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    outcome = install(dir);
    if (outcome.status === 0) {
      break;
    }
    if (attempt === 3 || !TRANSIENT_NPM_FAILURE.test(outcome.output)) {
      break;
    }
    stdout += `npm install failed transiently — retrying (attempt ${attempt + 1} of 3)...\n`;
  }
  if (outcome.status !== 0) {
    return {
      exitCode: 1,
      stdout,
      stderr: `npm install failed — the scaffold is intact; fix the network and run npm install in ${dirName}/\n${outcome.output}`,
    };
  }

  stdout += `\nnext:\n  cd ${dirName}\n  npm test\n`;
  return { exitCode: 0, stdout, stderr: "" };
}
