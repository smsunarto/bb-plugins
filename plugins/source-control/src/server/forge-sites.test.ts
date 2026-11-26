import { Effect } from "effect";
import { expect, test } from "vitest";
import type { Placement } from "../core/change.ts";
import type { Exec } from "../forge/github.ts";
import { createForgeSites, type HostForge } from "./forge-sites.ts";

const REPO = { owner: "smsunarto", name: "bb-plugins" };
const PLACEMENT: Placement = {
  hostId: "host-a",
  hostName: "studio-mac",
  path: "/Users/scott/bb-plugins",
  environmentId: "env-a",
};

const EMPTY_PR_RESPONSE = JSON.stringify({
  data: { repository: { pullRequests: { nodes: [] } } },
});

function authStatus(accounts: readonly string[]) {
  return {
    code: 0,
    stdout: accounts
      .map(
        (login, index) =>
          `github.com\n  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: ${index === 0}`,
      )
      .join("\n"),
    stderr: "",
  };
}

const NO_HOST_FORGE: HostForge = {
  accounts: async () => ({ ok: true, value: { accounts: [] } }),
  pullRequest: async () => ({ ok: false, error: { code: "failed", message: "unused" } }),
  setDraft: async () => ({ ok: false, error: { code: "failed", message: "unused" } }),
  close: async () => ({ ok: false, error: { code: "failed", message: "unused" } }),
  merge: async () => ({ ok: false, error: { code: "failed", message: "unused" } }),
  review: async () => ({ ok: false, error: { code: "failed", message: "unused" } }),
  submitReview: async () => ({ ok: false, error: { code: "failed", message: "unused" } }),
};

test("seen repo access survives transient rate-limit and timeout failures, and evicts on auth/not-found", async () => {
  const accounts = ["acct-a", "acct-b"];
  const triedLogins: string[] = [];
  let mode: "ok-b" | "rate-limit-b" | "timeout-b" | "not-found-b" | "ok-a" = "ok-b";

  const serverExec: Exec = async (args, options) => {
    if (args[0] === "auth" && args[1] === "status") return authStatus(accounts);
    if (args[0] === "auth" && args[1] === "token") {
      const login = args[args.indexOf("--user") + 1]!;
      return { code: 0, stdout: `tok-${login}\n`, stderr: "" };
    }
    const token = options?.env?.GH_TOKEN ?? "";
    const login = token.replace(/^tok-/, "") || accounts[0]!;
    triedLogins.push(login);
    if (login === "acct-a") {
      if (mode === "ok-a") return { code: 0, stdout: EMPTY_PR_RESPONSE, stderr: "" };
      return { code: 1, stdout: "", stderr: "Could not resolve to a Repository" };
    }
    if (mode === "rate-limit-b")
      return { code: 1, stdout: "", stderr: "API rate limit exceeded for user" };
    if (mode === "timeout-b") return { code: 1, stdout: "", stderr: "i/o timeout" };
    if (mode === "not-found-b")
      return { code: 1, stdout: "", stderr: "Could not resolve to a Repository" };
    return { code: 0, stdout: EMPTY_PR_RESPONSE, stderr: "" };
  };

  const sites = createForgeSites({ serverExec, host: NO_HOST_FORGE, now: () => 1_000 });
  const read = () =>
    Effect.runPromise(
      sites
        .pullRequestVia({ repo: REPO, headOwner: "smsunarto", branch: "feat/x" }, [PLACEMENT])
        .pipe(Effect.result),
    );

  // First read: acct-a cannot see repo, acct-b succeeds and is remembered in `seen`.
  expect((await read())._tag).toBe("Success");
  expect(triedLogins).toEqual(["acct-a", "acct-b"]);
  triedLogins.length = 0;

  // Transient rate limit on acct-b does NOT evict `seen`, so next read goes straight to acct-b.
  mode = "rate-limit-b";
  expect((await read())._tag).toBe("Failure");
  expect(triedLogins).toEqual(["acct-b"]);
  triedLogins.length = 0;

  mode = "timeout-b";
  expect((await read())._tag).toBe("Failure");
  expect(triedLogins).toEqual(["acct-b"]);
  triedLogins.length = 0;

  // Recovery still goes straight to acct-b without trying acct-a.
  mode = "ok-b";
  expect((await read())._tag).toBe("Success");
  expect(triedLogins).toEqual(["acct-b"]);
  triedLogins.length = 0;

  // Permanent not-found on acct-b DOES evict `seen` and falls back to acct-a.
  mode = "not-found-b";
  expect((await read())._tag).toBe("Failure");
  expect(triedLogins).toEqual(["acct-b", "acct-a"]);
  triedLogins.length = 0;

  mode = "ok-a";
  expect((await read())._tag).toBe("Success");
  expect(triedLogins).toEqual(["acct-a"]);
});
