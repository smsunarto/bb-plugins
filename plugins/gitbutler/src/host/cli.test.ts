import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ButFailedError, ButMissingError, runBut, runGit } from "./cli.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const missingDirectory = join(here, "no-such-directory-for-this-test");
const signal = new AbortController().signal;

test("a missing working directory is reported as a missing repository", async () => {
  // Node raises the same ENOENT for a missing program and a missing cwd, so a
  // repository that moved must not read as "the CLI is not installed".
  const failure = await runGit(missingDirectory, ["status"], signal).catch((error) => error);
  expect(failure).toBeInstanceOf(ButFailedError);
  expect(failure).not.toBeInstanceOf(ButMissingError);
  expect((failure as Error).message).toBe("The repository directory is no longer available.");
});

test("but in a missing working directory is not reported as an uninstalled CLI", async () => {
  const failure = await runBut(missingDirectory, ["status"], signal).catch((error) => error);
  expect(failure).not.toBeInstanceOf(ButMissingError);
});

test("git failures surface the command's own message", async () => {
  const failure = await runGit(here, ["cat-file", "-p", "notacommit"], signal).catch(
    (error) => error,
  );
  expect(failure).toBeInstanceOf(ButFailedError);
  expect((failure as Error).message).not.toBe("");
});
