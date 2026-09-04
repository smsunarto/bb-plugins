import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatPlan } from "./format.ts";
import { buildPlan, type SyncPlan } from "./plan.ts";

const USAGE = `notes-sync - publish a notes directory into the site input tree

Usage:
  notes-sync --source <dir> --target <dir> [options]

Options:
  --source <dir>   directory holding the authored notes (required)
  --target <dir>   directory the published notes are written into (required)
  --keep-removed   leave published notes that no longer exist in the source
  --quiet          print the summary line only
  -h, --help       show this message
`;

export interface Options {
  source: string;
  target: string;
  keepRemoved: boolean;
  quiet: boolean;
}

/** Returns null when the caller asked for help. */
export function parseArgs(argv: string[]): Options | null {
  const options: Options = { source: "", target: "", keepRemoved: false, quiet: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--source":
      case "--target": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-"))
          throw new Error(`${arg} needs a directory`);
        if (arg === "--source") options.source = value;
        else options.target = value;
        i += 1;
        break;
      }
      case "--keep-removed":
        options.keepRemoved = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "-h":
      case "--help":
        return null;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.source === "" || options.target === "") {
    throw new Error("both --source and --target are required");
  }
  return options;
}

export function applyPlan(plan: SyncPlan): void {
  for (const change of plan.changes) {
    const destination = join(plan.target, change.path);
    if (change.kind === "remove") {
      rmSync(destination, { force: true });
      continue;
    }
    if (change.body === undefined) continue;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, change.body, "utf8");
  }
}

export function main(argv: string[]): number {
  let options: Options | null;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (options === null) {
    process.stdout.write(USAGE);
    return 0;
  }

  const source = resolve(options.source);
  const target = resolve(options.target);
  if (!existsSync(source)) {
    process.stderr.write(`source directory not found: ${source}\n`);
    return 1;
  }

  const startedAt = Date.now();
  const plan = buildPlan(source, target);
  if (options.keepRemoved) {
    plan.changes = plan.changes.filter((change) => change.kind !== "remove");
  }

  applyPlan(plan);

  const summary = formatPlan(plan, Date.now() - startedAt);
  process.stdout.write(`${options.quiet ? summary.split("\n").at(-1) : summary}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
