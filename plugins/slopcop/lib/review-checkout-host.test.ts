import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareCheckout, resolveSource } from "../host";

it("fetches a retained PR ref and verifies its SHA before adding the worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slopcop-checkout-"));
  const calls: string[][] = [];
  const input = {
    source: root,
    path: path.join(root, "worktree"),
    ref: "refs/slopcop/thr_test",
    number: 1125,
    head: "3".repeat(40),
    base: "main",
  };
  try {
    const result = await prepareCheckout(input, new AbortController().signal, async (_, args) => {
      calls.push(args);
      return args[0] === "rev-parse" ? input.head : "";
    });
    expect(result.path).toBe(input.path);
    expect(calls).toEqual([
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/pull/1125/head:refs/slopcop/thr_test",
        "+refs/heads/main:refs/remotes/origin/main",
      ],
      ["rev-parse", "refs/slopcop/thr_test"],
      ["worktree", "add", "--detach", input.path, input.head],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("refuses a changed PR head without creating a worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slopcop-checkout-"));
  const calls: string[][] = [];
  try {
    await expect(
      prepareCheckout(
        {
          source: root,
          path: path.join(root, "worktree"),
          ref: "refs/slopcop/thr_test",
          number: 1125,
          head: "3".repeat(40),
        },
        new AbortController().signal,
        async (_, args) => {
          calls.push(args);
          return "4".repeat(40);
        },
      ),
    ).rejects.toThrow("PR head changed");
    expect(calls.some((args) => args[0] === "worktree")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withHome(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "slopcop-home-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
async function fakeClone(dir: string, origin: string) {
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await writeFile(
    path.join(dir, ".git", "config"),
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
}
const noGit = async () => {
  throw new Error("unexpected git call");
};
const signal = new AbortController().signal;

it("uses BB's project checkout when the machine has one", async () => {
  await withHome(async (home) => {
    await fakeClone(path.join(home, "rc"), "git@github.com:Argus-Labs/rampage-client.git");
    expect(
      await resolveSource(
        { remote: "https://github.com/Argus-Labs/rampage-client", preferred: "/srv/checkout" },
        signal,
        home,
        noGit,
      ),
    ).toEqual({ source: "/srv/checkout" });
  });
});

it("reuses a warm image's clone whose origin names the project remote", async () => {
  await withHome(async (home) => {
    await fakeClone(path.join(home, "other"), "git@github.com:Argus-Labs/world-engine.git");
    await fakeClone(path.join(home, "rc"), "git@github.com:Argus-Labs/rampage-client.git");
    await fakeClone(path.join(home, "git", "monorepo"), "https://github.com/argus-labs/monorepo/");
    expect(
      await resolveSource(
        { remote: "https://github.com/Argus-Labs/rampage-client.git", preferred: null },
        signal,
        home,
        noGit,
      ),
    ).toEqual({ source: path.join(home, "rc") });
    expect(
      await resolveSource(
        { remote: "git@github.com:Argus-Labs/monorepo.git", preferred: null },
        signal,
        home,
        noGit,
      ),
    ).toEqual({ source: path.join(home, "git", "monorepo") });
  });
});

it("partially clones a missing repository once and reuses it", async () => {
  await withHome(async (home) => {
    const remote = "https://github.com/Argus-Labs/world-engine.git";
    const calls: string[][] = [];
    const clone = async (dir: string, args: string[]) => {
      calls.push(args);
      await fakeClone(dir, remote);
      return "";
    };
    const first = await resolveSource({ remote, preferred: null }, signal, home, clone);
    expect(calls).toEqual([["clone", "--filter=blob:none", "--no-checkout", remote, "."]]);
    expect(first.source).toBe(
      path.join(home, ".slopcop", "sources", "github.com-argus-labs-world-engine"),
    );
    expect(await resolveSource({ remote, preferred: null }, signal, home, noGit)).toEqual(first);
  });
});

it("leaves no source behind when the clone fails", async () => {
  await withHome(async (home) => {
    await expect(
      resolveSource(
        { remote: "https://github.com/Argus-Labs/world-engine.git", preferred: null },
        signal,
        home,
        async () => {
          throw new Error("auth failed");
        },
      ),
    ).rejects.toThrow("auth failed");
    expect(await readdir(path.join(home, ".slopcop", "sources"))).toEqual([]);
  });
});
