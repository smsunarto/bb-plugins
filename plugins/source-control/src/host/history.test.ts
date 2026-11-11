// Ported from plugins/gitbutler/src/host/history.test.ts (the readBaseHistory half).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { runGit } from "./cli.ts";
import { readBaseHistory } from "./history.ts";
import hostEntry from "./host.ts";

const signal = new AbortController().signal;
let repository = "";

/** Five commits, newest last. One has no subject, which git allows and must not cost the one below. */
const SUBJECTS = ["first", "second", "", "third", "fourth"] as const;

beforeAll(async () => {
  repository = await mkdtemp(join(tmpdir(), "source-control-history-"));
  await runGit(repository, ["init", "--quiet", "--initial-branch=main", "."], signal);
  await runGit(repository, ["config", "user.email", "test@example.com"], signal);
  await runGit(repository, ["config", "user.name", "Test Person"], signal);
  await runGit(repository, ["config", "commit.gpgsign", "false"], signal);
  for (const subject of SUBJECTS) {
    await writeFile(join(repository, "file.txt"), `${subject}\n`);
    await runGit(repository, ["add", "file.txt"], signal);
    await runGit(
      repository,
      [
        "commit",
        "--quiet",
        "--allow-empty-message",
        "-m",
        `${subject}${subject ? "\n\nbody" : ""}`,
      ],
      signal,
    );
  }
});

afterAll(async () => {
  await rm(repository, { recursive: true, force: true });
});

test("history starts below the base, which already has its own row, subjects only", async () => {
  const page = await readBaseHistory(repository, "HEAD", 10, signal);
  expect(page.commits.map((commit) => commit.subject)).toEqual(["third", "", "second", "first"]);
  expect(page.hasMore).toBe(false);
  expect(page.commits[0]!.id).toMatch(/^[0-9a-f]{40}$/);
  expect(Number.isNaN(Date.parse(page.commits[0]!.createdAt))).toBe(false);
});

test("a shorter window says there are more", async () => {
  const page = await readBaseHistory(repository, "HEAD", 2, signal);
  expect(page.commits.map((commit) => commit.subject)).toEqual(["third", ""]);
  expect(page.hasMore).toBe(true);
});

test("the host reads it for a checkout, and refuses a path that is not one", async () => {
  const host = experimental_createHostEntryHarness(hostEntry);
  try {
    const head = (await runGit(repository, ["rev-parse", "HEAD"], signal)).trim();
    const answer = await host.experimental_call("baseHistory", {
      path: repository,
      from: head,
      limit: 1,
    });
    expect(answer).toMatchObject({ ok: true, value: { hasMore: true } });
    const outside = await mkdtemp(join(tmpdir(), "source-control-not-git-"));
    expect(
      await host.experimental_call("baseHistory", { path: outside, from: head, limit: 1 }),
    ).toMatchObject({ ok: false });
    await rm(outside, { recursive: true, force: true });
  } finally {
    await host.experimental_dispose();
  }
});
