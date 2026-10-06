import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Put a shell script named `but` first on PATH, so a test can have the CLI
 * answer the way a real install does without needing one. cli.ts reads PATH
 * on every call, so the script answers from the next call on. Returns the
 * undo.
 */
export async function fakeBut(script: string): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), "gitbutler-fake-but-"));
  await writeFile(join(directory, "but"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const path = process.env["PATH"] ?? "";
  process.env["PATH"] = `${directory}${delimiter}${path}`;
  return async () => {
    process.env["PATH"] = path;
    await rm(directory, { recursive: true, force: true });
  };
}
