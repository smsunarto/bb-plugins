/**
 * The watch signal, for both providers: a read keeps the checkout watched,
 * a real change says so once under the server's own name for the checkout,
 * and the host's own reads, ignored files, and git's churn say nothing.
 * Ported from `plugins/gitbutler/src/host/repository-state.test.ts`.
 */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type {
  ExperimentalHostWatchListener,
  ExperimentalHostWatchOptions,
} from "@get-bb/plugin-sdk/host";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { WATCH_LEASE_MS } from "../contract/host.ts";
import { fakeBut } from "../../test/fake-but.ts";
import { isolate } from "../../test/isolate.ts";
import { buildRepos, git, type Repos } from "../../test/repos.ts";
import hostEntry from "./host.ts";

const env = await isolate("source-control-watch");
let repos: Repos;

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
  const at = (rootPath: string) => {
    const found = watches.findLast((watch) => watch.options.rootPath === rootPath);
    if (!found) throw new Error(`nothing watches ${rootPath}`);
    return found.listener;
  };
  return { host, watches, at, disposed: () => disposed };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
let hosts: { experimental_dispose(): Promise<void> }[] = [];

beforeAll(async () => {
  repos = await buildRepos(env.root, env.but !== null);
}, 60_000);

afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts) await host.experimental_dispose();
  hosts = [];
});

afterAll(async () => {
  await env.cleanup();
});

const cases = [
  { provider: "git", path: () => repos.plain },
  ...(env.but === null ? [] : [{ provider: "gitbutler", path: () => repos.gitbutler! }]),
] as const;

if (env.but === null) {
  test.skip("GitButler provider: no `but` CLI on this machine, so its half is skipped", () => {});
}

describe.each(cases)("$provider provider", ({ provider, path }) => {
  /** The server's name for the checkout, which is not its real path. */
  const named = () => join(env.root, `linked-${provider}`);
  const commonDir = () => join(path(), ".git");

  beforeAll(async () => {
    await symlink(path(), named());
  });

  async function watching() {
    const watched = watchedHost();
    hosts.push(watched.host);
    const read = await watched.host.experimental_call("workspace", {
      path: named(),
      readAs: "auto",
    });
    expect(read.ok && read.value.state).toBe("workspace");
    return watched;
  }

  test("a read watches the Git directory and the working tree, once", async () => {
    const { host, watches } = await watching();
    expect(watches.map(({ options }) => options.rootPath).sort()).toEqual(
      [commonDir(), path()].sort(),
    );
    const tree = watches.find(({ options }) => options.rootPath === path())!;
    expect(tree.options.ignoredPaths).toContain(".git");
    const repository = watches.find(({ options }) => options.rootPath === commonDir())!;
    // Git's object and reflog churn never wakes it.
    expect(repository.options.ignoredPaths).toEqual(expect.arrayContaining(["objects", "logs"]));

    await host.experimental_call("workspace", { path: named(), readAs: "auto" });
    expect(await host.experimental_call("renewWatch", { path: named() })).toEqual({
      watching: true,
    });
    expect(watches).toHaveLength(2);
  });

  test("editing a tracked file signals once, naming the checkout as the server did", async () => {
    const { host, at } = await watching();
    await writeFile(join(path(), "one.txt"), "edited in an editor\n");
    try {
      await at(path())({
        kind: "changed",
        changes: [{ path: join(path(), "one.txt"), type: "update" }],
      });
      await at(commonDir())({ kind: "changed", changes: [] });
      expect(host.experimental_getSignals()).toEqual([
        { signal: "checkoutChanged", payload: { paths: [named()] } },
      ]);
    } finally {
      git(path(), "checkout", "--quiet", "--", "one.txt");
    }
  });

  test("the host's own reads signal nothing", async () => {
    const { host, at } = await watching();
    await host.experimental_call("workspace", { path: named(), readAs: "auto" });
    await host.experimental_call("patches", {
      path: named(),
      readAs: "auto",
      source: { kind: "uncommitted" },
    });
    await host.experimental_call("patches", {
      path: named(),
      readAs: "auto",
      source: { kind: "commit", commitId: repos.unpushed },
    });
    await settled();
    await at(commonDir())({ kind: "changed", changes: [] });
    // The Git directory's own files are left to its watch.
    await at(path())({
      kind: "changed",
      changes: [{ path: join(path(), ".git", "index"), type: "update" }],
    });
    expect(host.experimental_getSignals()).toEqual([]);
  });

  test("an ignored file signals nothing, and an untracked one does", async () => {
    const { host, at } = await watching();
    await mkdir(join(path(), "build"), { recursive: true });
    await writeFile(join(path(), "build", "out.js"), "built\n");
    await writeFile(join(path(), "note.txt"), "a new file\n");
    try {
      await at(path())({
        kind: "changed",
        changes: [{ path: join(path(), "build", "out.js"), type: "create" }],
      });
      expect(host.experimental_getSignals()).toEqual([]);
      await at(path())({ kind: "changed", changes: [{ path: "note.txt", type: "create" }] });
      expect(host.experimental_getSignals()).toEqual([
        { signal: "checkoutChanged", payload: { paths: [named()] } },
      ]);
    } finally {
      await rm(join(path(), "build"), { recursive: true, force: true });
      await rm(join(path(), "note.txt"), { force: true });
    }
  });

  test("a ref moved by someone else signals", async () => {
    const { host, at } = await watching();
    git(path(), "update-ref", "refs/heads/elsewhere", "HEAD");
    try {
      await at(commonDir())({ kind: "changed", changes: [] });
      expect(host.experimental_getSignals()).toEqual([
        { signal: "checkoutChanged", payload: { paths: [named()] } },
      ]);
    } finally {
      git(path(), "update-ref", "-d", "refs/heads/elsewhere");
    }
  });

  test("a write signals the checkout it named", async () => {
    const { host, at } = await watching();
    const result = await host.experimental_call("vcsAction", {
      path: named(),
      readAs: "auto",
      action: { kind: "pull", accepted: null },
      expected: { head: null, target: repos.base },
    });
    expect(result).toEqual({ status: "upToDate" });
    expect(host.experimental_getSignals()).toEqual([
      { signal: "checkoutChanged", payload: { paths: [named()] } },
    ]);
    // The daemon's event for the same write finds nothing new.
    await at(commonDir())({ kind: "changed", changes: [] });
    expect(host.experimental_getSignals()).toHaveLength(1);
  });

  test("a stale write signals nothing", async () => {
    const { host } = await watching();
    const result = await host.experimental_call("vcsAction", {
      path: named(),
      readAs: "auto",
      action: { kind: "pull", accepted: null },
      expected: { head: null, target: "0".repeat(40) },
    });
    expect(result.status).toBe("conflict");
    expect(host.experimental_getSignals()).toEqual([]);
  });

  test("a lease runs out, and both its watches go", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { disposed } = await watching();
    vi.advanceTimersByTime(WATCH_LEASE_MS - 1);
    await Promise.resolve();
    expect(disposed()).toBe(0);
    vi.advanceTimersByTime(2);
    vi.useRealTimers();
    await settled();
    expect(disposed()).toBe(2);
  });

  test("a broken watch goes, and the next read arms a new one", async () => {
    const { host, watches, at, disposed } = await watching();
    await at(commonDir())({ kind: "watch-error", message: "gone" });
    await settled();
    // Its viewers go with it, so their working tree's watch goes too.
    expect(disposed()).toBe(2);
    await host.experimental_call("workspace", { path: named(), readAs: "auto" });
    expect(watches).toHaveLength(4);
  });
});

test("renewing a checkout nobody read arms its watch; a path that is no checkout is not watched", async () => {
  const { host, watches } = watchedHost();
  hosts.push(host);
  expect(await host.experimental_call("renewWatch", { path: repos.plain })).toEqual({
    watching: true,
  });
  expect(watches).toHaveLength(2);
  expect(await host.experimental_call("renewWatch", { path: env.root })).toEqual({
    watching: false,
  });
});

test("a read that writes GitButler's state never wakes the server, even while it runs", async () => {
  // A GitButler workspace whose `but` writes its database as `status` reads.
  const workspace = join(env.root, "fake-workspace");
  git(env.root, "init", "--quiet", "--initial-branch=gitbutler/workspace", workspace);
  await writeFile(join(workspace, "file.txt"), "base\n");
  git(workspace, "add", "file.txt");
  git(workspace, "commit", "--quiet", "-m", "chore: base");
  const status = join(env.root, "status.json");
  await writeFile(status, JSON.stringify({ uncommittedChanges: [], stacks: [] }));
  const restore = await fakeBut(
    [
      `case "$1 $2" in`,
      `  "status -u") mkdir -p .git/gitbutler; date +%s%N >> .git/gitbutler/but.sqlite; sleep 0.4; cat '${status}' ;;`,
      `  *) echo '{}' ;;`,
      `esac`,
    ].join("\n"),
  );
  try {
    const { host, at } = watchedHost();
    hosts.push(host);
    await host.experimental_call("workspace", { path: workspace, readAs: "auto" });
    const listener = at(join(workspace, ".git"));
    await settled();

    // The daemon reports the read's own write before the read is done.
    const reading = host.experimental_call("workspace", { path: workspace, readAs: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await listener({ kind: "changed", changes: [] });
    expect(host.experimental_getSignals()).toEqual([]);
    await reading;
    await settled();
    await listener({ kind: "changed", changes: [] });
    expect(host.experimental_getSignals()).toEqual([]);

    // The same file written by someone else is a change.
    await writeFile(join(workspace, ".git", "gitbutler", "but.sqlite"), "elsewhere\n", {
      flag: "a",
    });
    await listener({ kind: "changed", changes: [] });
    expect(host.experimental_getSignals()).toHaveLength(1);
  } finally {
    await restore();
  }
});
