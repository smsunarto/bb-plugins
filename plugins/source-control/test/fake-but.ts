/**
 * Put a shell script named `but` first on PATH, so a test can have the CLI
 * answer the way a real install does without running one. The host resolves
 * PATH on every call, so the script answers from the next call on. Returns
 * the undo. Ported from `plugins/gitbutler/test/fake-but.ts`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export async function fakeBut(script: string): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), "source-control-fake-but-"));
  await writeFile(join(directory, "but"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const path = process.env["PATH"] ?? "";
  process.env["PATH"] = `${directory}${delimiter}${path}`;
  return async () => {
    process.env["PATH"] = path;
    await rm(directory, { recursive: true, force: true });
  };
}

/** Answers `scriptedBut` gives one argv in turn, one per call, repeating the last. */
export class Turns {
  readonly answers: unknown[];
  constructor(answers: unknown[]) {
    this.answers = answers;
  }
}
export const turns = (...answers: unknown[]) => new Turns(answers);

/**
 * A `but` that answers each argv from `answers` and logs every call. An argv
 * it was not given fails the way `but` refuses, so a call the flow should not
 * make shows up as an error or in the log. Returns the call log and the undo.
 */
export async function scriptedBut(
  answers: Record<string, unknown>,
): Promise<{ calls: () => Promise<string[]>; restore: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "source-control-scripted-"));
  const cases = await Promise.all(
    Object.entries(answers).map(async ([argv, answer], index) => {
      const each = answer instanceof Turns ? answer.answers : [answer];
      await Promise.all(
        each.map((one, turn) =>
          writeFile(
            join(directory, `${index}.${turn}.out`),
            typeof one === "string" ? one : JSON.stringify(one),
          ),
        ),
      );
      const counter = join(directory, `${index}.turn`);
      return [
        `  "${argv} --json")`,
        `    n=$(cat '${counter}' 2>/dev/null || echo 0)`,
        `    [ "$n" -lt ${each.length - 1} ] && echo $((n + 1)) > '${counter}'`,
        `    cat '${directory}/${index}.'$n'.out' ;;`,
      ].join("\n");
    }),
  );
  const log = join(directory, "calls.log");
  const undo = await fakeBut(
    [
      `echo "$*" >> '${log}'`,
      'case "$*" in',
      ...cases,
      '  *) echo "Error: unexpected $*" >&2; exit 1 ;;',
      "esac",
    ].join("\n"),
  );
  return {
    calls: async () =>
      (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== ""),
    restore: async () => {
      await undo();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
