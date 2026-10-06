import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeBut } from "../../test/fake-but.ts";
import {
  ButFailedError,
  ButMissingError,
  ButSetupRequiredError,
  runBut,
  runButAction,
  runGit,
} from "./cli.ts";

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
  expect(failure).toBeInstanceOf(ButFailedError);
  expect(failure).not.toBeInstanceOf(ButMissingError);
  expect((failure as Error).message).toBe("The repository directory is no longer available.");
});

test("git failures surface the command's own message", async () => {
  const failure = await runGit(here, ["cat-file", "-p", "notacommit"], signal).catch(
    (error) => error,
  );
  expect(failure).toBeInstanceOf(ButFailedError);
  expect((failure as Error).message).toContain("notacommit");
});

test("git output past the buffer reads as a diff too large to show", async () => {
  // An alias stands in for `git show` on a commit of 34 MB.
  const args = ["-c", "alias.huge=!head -c 34000000 /dev/zero", "huge"];
  const failure = await runGit(here, args, signal).catch((error) => error);
  expect(failure).toBeInstanceOf(ButFailedError);
  expect((failure as Error).message).toBe("This diff is too large to show.");
});

test("a refused action reads as what failed and why, without the CLI's hint", async () => {
  const restore = await fakeBut(
    "printf 'Error: Branch not found\\nCaused by:\\n  no ref\\nHint: run but status\\n' >&2; exit 1",
  );
  try {
    const failure = await runButAction(here, ["push", "x"], signal).catch((error) => error);
    expect(failure).toBeInstanceOf(ButFailedError);
    expect((failure as Error).message).toBe("Branch not found no ref");
  } finally {
    await restore();
  }
});

test("a repository GitButler has not set up is told apart from other refusals", async () => {
  const restore = await fakeBut(
    `echo '{"error":"setup_required","message":"No GitButler project found at ."}'; exit 1`,
  );
  try {
    const failure = await runBut(here, ["status"], signal).catch((error) => error);
    expect(failure).toBeInstanceOf(ButSetupRequiredError);
    expect((failure as Error).message).toBe("No GitButler project found at .");
  } finally {
    await restore();
  }
});
