import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExperimentalHostWatchListener,
  ExperimentalHostWatchOptions,
} from "@get-bb/plugin-sdk/host";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { fakeBut } from "../../test/fake-but.ts";
import { statusPayload } from "../../test/fixtures.ts";
import { runGit } from "./cli.ts";
import hostEntry from "./host.ts";

const signal = new AbortController().signal;
let scratch = "";
let log = "";
let restore: (() => Promise<void>) | undefined;

type Watch = { options: ExperimentalHostWatchOptions; listener: ExperimentalHostWatchListener };

/** A host whose watches are recorded, so a test plays the daemon's change events. */
function watchedHost() {
  const watches: Watch[] = [];
  let disposed = 0;
  const host = experimental_createHostEntryHarness(hostEntry, {
    experimental_watch: (options, listener) => {
      watches.push({ options, listener });
      return {
        dispose: async () => {
          disposed += 1;
        },
      };
    },
  });
  return { host, watches, disposed: () => disposed };
}

/** A GitButler workspace with one commit, alone in its own directory. */
async function workspaceRepository(name: string): Promise<string> {
  const path = join(scratch, name);
  await runGit(scratch, ["init", "--quiet", "--initial-branch=gitbutler/workspace", path], signal);
  await runGit(path, ["config", "user.email", "test@example.com"], signal);
  await runGit(path, ["config", "user.name", "Test Person"], signal);
  await runGit(path, ["config", "commit.gpgsign", "false"], signal);
  await commit(path, "base");
  return realpath(path);
}

async function commit(path: string, content: string) {
  await writeFile(join(path, "file.txt"), `${content}\n`);
  await runGit(path, ["add", "file.txt"], signal);
  await runGit(path, ["commit", "--quiet", "-m", `chore: ${content}`], signal);
}

/** A `but` that logs each call, answers `status -u` a moment later, and lets pulls through. */
async function slowStatus() {
  const answers = join(scratch, "status.json");
  await writeFile(answers, JSON.stringify(statusPayload));
  restore = await fakeBut(
    [
      `printf '%s\\n' "$*" >> '${log}'`,
      `case "$1 $2" in`,
      `  "status -u") sleep 0.2; cat '${answers}' ;;`,
      `  "pull --check") echo '{"branchStatuses":[],"upToDate":false,"hasWorktreeConflicts":false}' ;;`,
      `  *) ;;`,
      `esac`,
    ].join("\n"),
  );
}

/** A `but` whose `status -u` writes GitButler's database, then answers a moment later. */
async function writingStatus() {
  const answers = join(scratch, "status.json");
  await writeFile(answers, JSON.stringify(statusPayload));
  restore = await fakeBut(
    [
      `printf '%s\\n' "$*" >> '${log}'`,
      `case "$1 $2" in`,
      `  "status -u") mkdir -p .git/gitbutler; date +%s%N >> .git/gitbutler/but.sqlite; sleep 0.4; cat '${answers}' ;;`,
      `  *) ;;`,
      `esac`,
    ].join("\n"),
  );
}

/** Git run by someone else, such as an agent in a terminal: not one of the host's processes. */
function elsewhere(path: string, args: string[]) {
  execFileSync("git", args, { cwd: path, stdio: "ignore" });
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

async function butCalls(): Promise<string[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "gitbutler-state-"));
  log = join(scratch, "but.log");
});

afterEach(async () => {
  await restore?.();
  restore = undefined;
  await rm(log, { force: true });
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("reading a board watches its repository, and a commit on disk names the checkout it moved", async () => {
  await slowStatus();
  const repository = await workspaceRepository("watched");
  const { host, watches } = watchedHost();

  await host.experimental_call("workspace", { environmentPath: repository });
  expect(watches).toHaveLength(1);
  const [{ options, listener }] = watches as [Watch];
  expect(options.rootPath).toBe(join(repository, ".git"));
  // Git's object and reflog churn never wakes it.
  expect(options.ignoredPaths).toEqual(expect.arrayContaining(["objects", "logs"]));

  // Nothing moved: an event alone says nothing.
  await listener({ kind: "changed", changes: [] });
  expect(host.experimental_getSignals()).toEqual([]);

  // Someone commits in a terminal.
  await writeFile(join(repository, "file.txt"), "from a terminal\n");
  elsewhere(repository, ["commit", "--quiet", "-am", "chore: from a terminal"]);
  await listener({ kind: "changed", changes: [] });
  expect(host.experimental_getSignals()).toEqual([
    {
      signal: "repositoryChanged",
      payload: { commonDir: join(repository, ".git"), checkouts: [repository] },
    },
  ]);

  // A second read of the same repository renews the watch rather than adding one.
  await host.experimental_call("workspace", { environmentPath: repository });
  expect(watches).toHaveLength(1);
  await host.experimental_dispose();
});

test("what a read writes is not a change, but a ref that moved while it ran still is", async () => {
  await slowStatus();
  const repository = await workspaceRepository("own-writes");
  const { host, watches } = watchedHost();
  await host.experimental_call("workspace", { environmentPath: repository });
  const [{ listener }] = watches as [Watch];

  // `git status` and `but` refresh the index as they read.
  await writeFile(join(repository, "file.txt"), "touched\n");
  await runGit(repository, ["add", "file.txt"], signal);
  await host.experimental_call("workspace", { environmentPath: repository });
  await listener({ kind: "changed", changes: [] });
  expect(host.experimental_getSignals()).toEqual([]);

  // A commit lands while a read runs. The read takes the index, never the ref.
  const reading = host.experimental_call("workspace", { environmentPath: repository });
  elsewhere(repository, ["commit", "--quiet", "-m", "chore: during a read"]);
  await reading;
  await listener({ kind: "changed", changes: [] });
  expect(host.experimental_getSignals()).toHaveLength(1);
  await host.experimental_dispose();
});

test("a read that writes GitButler's state never wakes its panel, even while it runs", async () => {
  await writingStatus();
  const repository = await workspaceRepository("reading-writes");
  const { host, watches } = watchedHost();
  await host.experimental_call("workspace", { environmentPath: repository });
  const [{ listener }] = watches as [Watch];
  await settled();

  // The daemon reports the read's own write before the read is done.
  const reading = host.experimental_call("workspace", { environmentPath: repository });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await listener({ kind: "changed", changes: [] });
  expect(host.experimental_getSignals()).toEqual([]);
  await reading;
  await settled();
  await listener({ kind: "changed", changes: [] });
  expect(host.experimental_getSignals()).toEqual([]);

  // The same file written by someone else is a change.
  await writeFile(join(repository, ".git", "gitbutler", "but.sqlite"), "elsewhere\n", {
    flag: "a",
  });
  await listener({ kind: "changed", changes: [] });
  expect(host.experimental_getSignals()).toHaveLength(1);
  await host.experimental_dispose();
});

test("a write tells every panel showing its repository, once", async () => {
  await slowStatus();
  const repository = await workspaceRepository("write-announces");
  const { host, watches } = watchedHost();
  await host.experimental_call("workspace", { environmentPath: repository });
  const [{ listener }] = watches as [Watch];

  await host.experimental_call("butAction", {
    environmentPath: repository,
    action: { kind: "updateWorkspace", accepted: null },
  });
  await settled();
  const announced = {
    signal: "repositoryChanged" as const,
    payload: { commonDir: join(repository, ".git"), checkouts: [repository] },
  };
  expect(host.experimental_getSignals()).toEqual([announced]);
  // The daemon's event for the same write finds nothing new.
  await listener({ kind: "changed", changes: [] });
  expect(host.experimental_getSignals()).toEqual([announced]);
  await host.experimental_dispose();
});

test("a broken watch goes, and the next read arms a new one", async () => {
  await slowStatus();
  const repository = await workspaceRepository("broken");
  const { host, watches, disposed } = watchedHost();
  await host.experimental_call("workspace", { environmentPath: repository });
  await watches[0]!.listener({ kind: "watch-error", message: "gone" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(disposed()).toBe(1);

  await host.experimental_call("workspace", { environmentPath: repository });
  expect(watches).toHaveLength(2);
  await host.experimental_dispose();
});

test("concurrent reads of one board share one `but status`, and a write is never answered from before it", async () => {
  await slowStatus();
  const environment = join(scratch, "environment");
  await mkdir(join(environment, "repos"), { recursive: true });
  const first = await workspaceRepository("environment/repos/first");
  const { host } = watchedHost();

  const boards = await Promise.all([
    host.experimental_call("workspace", { environmentPath: first }),
    host.experimental_call("workspace", { environmentPath: first }),
  ]);
  expect(boards.map((board) => board.state)).toEqual(["ready", "ready"]);
  expect((await butCalls()).filter((call) => call.startsWith("status -u"))).toHaveLength(1);

  // Discovery is remembered for a few seconds, so a repository cloned just
  // now is not listed yet...
  const listed = async () =>
    (await host.experimental_call("repositories", { environmentPath: environment })).repositories;
  expect((await listed()).map(({ key }) => key)).toEqual(["repos/first"]);
  await workspaceRepository("environment/repos/second");
  expect((await listed()).map(({ key }) => key)).toEqual(["repos/first"]);

  // ...but a write forgets everything read before it.
  const { result, board } = await host.experimental_call("butAction", {
    environmentPath: environment,
    repositoryKey: "repos/first",
    action: { kind: "updateWorkspace", accepted: null },
  });
  expect(result).toEqual({ status: "done" });
  // The write hands back the board it left.
  expect(board?.state).toBe("ready");
  expect((await listed()).map(({ key }) => key)).toEqual(["repos/first", "repos/second"]);
  await host.experimental_dispose();
});

test("a write aimed at where the server last saw the checkout is refused once it is elsewhere", async () => {
  await slowStatus();
  const repository = await workspaceRepository("expected");
  const { host } = watchedHost();
  const write = (path: string) =>
    host.experimental_call("butAction", {
      environmentPath: repository,
      expectedCheckout: { path, commonDir: join(repository, ".git") },
      action: { kind: "updateWorkspace", accepted: null },
    });

  await expect(write(join(scratch, "moved"))).rejects.toThrow("The checkout moved");
  expect((await butCalls()).filter((call) => call.startsWith("pull"))).toEqual([]);
  expect((await write(repository)).result).toEqual({ status: "done" });
  await host.experimental_dispose();
});
