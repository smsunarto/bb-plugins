import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  type GhRunner,
  type RunResult,
  createGh,
  createGitHub,
  execGh,
  parseAuthStatus,
  runResult,
} from "./gh.ts";

/** A `gh` that prints `result` for every call. */
const answering = (result: RunResult) => createGh(async () => result);

/** What `gh api graphql` prints for a GraphQL answer: the body on stdout, exit 1 on errors. */
const graphqlAnswer = (body: { data: unknown; errors?: unknown[] }): RunResult => ({
  code: body.errors ? 1 : 0,
  stdout: JSON.stringify(body),
  stderr: "",
});

const SAML = "Resource protected by organization SAML enforcement.";

test("search hits GitHub will not show drop out, and the rest of the answer comes back", async () => {
  const data = { viewer: { login: "mona" }, requested: { nodes: [null, { number: 7 }, null] } };
  const gh = answering(
    graphqlAnswer({
      data,
      errors: [
        { type: "FORBIDDEN", path: ["requested", "nodes", 0], message: SAML },
        { type: "NOT_FOUND", path: ["requested", "nodes", 2], message: "Could not resolve." },
      ],
    }),
  );

  expect(await gh.graphql("query Inbox { viewer { login } }")).toEqual({
    viewer: { login: "mona" },
    requested: { nodes: [{ number: 7 }] },
  });
});

test("a hidden field inside a list item drops the item it bubbled up to", async () => {
  // A cross-reference from a private repository: `source` is non-null, so
  // GitHub nulls the whole timeline item and names the field in the path.
  const gh = answering(
    graphqlAnswer({
      data: { repository: { pullRequest: { timelineItems: { nodes: [{ id: "a" }, null] } } } },
      errors: [
        {
          type: "FORBIDDEN",
          path: ["repository", "pullRequest", "timelineItems", "nodes", 1, "source"],
          message: SAML,
        },
      ],
    }),
  );

  expect(await gh.graphql("query PullRequest { repository }")).toEqual({
    repository: { pullRequest: { timelineItems: { nodes: [{ id: "a" }] } } },
  });
});

test("an optional root the viewer may not see comes back null, and any other root still fails", async () => {
  const answer = graphqlAnswer({
    data: { viewer: { login: "mona" }, p0: null, p1: { number: 2 } },
    errors: [{ type: "FORBIDDEN", path: ["p0"], message: SAML }],
  });
  const optionalRoot = (name: string) => /^p\d+$/.test(name);

  expect(await answering(answer).graphql("query Inbox { viewer }", {}, { optionalRoot })).toEqual({
    viewer: { login: "mona" },
    p0: null,
    p1: { number: 2 },
  });
  await expect(answering(answer).graphql("query Inbox { viewer }")).rejects.toMatchObject({
    code: "forbidden",
  });
});

test("a missing pull request still fails with not-found though GitHub sent data", async () => {
  const message = "Could not resolve to a PullRequest with the number of 99999.";
  const gh = answering(
    graphqlAnswer({
      data: { repository: { pullRequest: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message }],
    }),
  );

  await expect(gh.graphql("query PullRequestHead { repository }")).rejects.toMatchObject({
    code: "not-found",
    message,
  });
});

test("a forbidden list item with no data fails with forbidden", async () => {
  const gh = answering(
    graphqlAnswer({
      data: null,
      errors: [{ type: "FORBIDDEN", path: ["requested", "nodes", 0], message: SAML }],
    }),
  );

  await expect(gh.graphql("query Inbox { viewer { login } }")).rejects.toMatchObject({
    code: "forbidden",
    message: SAML,
  });
});

test("a rate limit beside a hidden search hit fails with rate-limited", async () => {
  const gh = answering(
    graphqlAnswer({
      data: { requested: { nodes: [null] } },
      errors: [
        { type: "FORBIDDEN", path: ["requested", "nodes", 0], message: SAML },
        { type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." },
      ],
    }),
  );

  await expect(gh.graphql("query Inbox { viewer { login } }")).rejects.toMatchObject({
    code: "rate-limited",
    message: "API rate limit exceeded for user ID 1.",
  });
});

test("a timed out gh reports the timeout, not its partial output", async () => {
  const gh = answering({ code: 1, stdout: "HTTP 404", stderr: "", failure: "timeout" });

  await expect(gh.text(["run", "view"])).rejects.toMatchObject({
    code: "failed",
    message: "GitHub CLI timed out after 30s.",
  });
});

test("a gh killed by its timeout reads as a timeout", async () => {
  const [error, stdout, stderr] = await new Promise<Parameters<typeof runResult>>((resolve) => {
    execFile("sleep", ["5"], { timeout: 20 }, (...result) => resolve(result));
  });

  expect(runResult(error, stdout, stderr)).toEqual({
    code: 1,
    stdout: "",
    stderr: "",
    failure: "timeout",
  });
});

/** Puts a shell script named `gh` first on PATH while `run` runs, so `execGh` spawns it. */
async function withFakeGh<T>(script: string, run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "code-review-gh-"));
  writeFileSync(join(dir, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  try {
    return await run();
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a job log over 32 MB reports its size, not a 404 read from the log", async () => {
  await withFakeGh('yes "HTTP 404 Not Found" | head -c 40000000', async () => {
    await expect(
      createGh(execGh).text(["api", "repos/o/r/actions/jobs/1/logs"]),
    ).rejects.toMatchObject({ code: "failed", message: "GitHub returned more than 32 MB." });
  });
});

test("gh exiting before it reads a large stdin body answers with its exit code", async () => {
  await withFakeGh('echo "unknown flag: --input" >&2; exit 3', async () => {
    const body = "x".repeat(4 * 1024 * 1024);

    expect(await execGh(["api", "graphql", "--input", "-"], body)).toEqual({
      code: 3,
      stdout: "",
      stderr: "unknown flag: --input\n",
    });
  });
});

// Recorded from gh 2.46 signed in to two accounts, one token since revoked.
const AUTH_STATUS = `github.com
  ✓ Logged in to github.com account sms-yui (/home/codex/.config/gh/hosts.yml)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************
  ✓ Logged in to github.com account smsunarto (keyring)
  - Active account: true
  - Token: gho_************************************
  X Failed to log in to github.com account old-bot (keyring)
  - Active account: false
  - The token in keyring is invalid.
`;

test("reads the signed-in accounts from gh auth status, the active one first", () => {
  expect(parseAuthStatus(AUTH_STATUS)).toEqual([
    { login: "smsunarto", env: false },
    { login: "sms-yui", env: false },
  ]);
  // gh before 2.40 knew one account and said "as".
  expect(
    parseAuthStatus("github.com\n  ✓ Logged in to github.com as mona (oauth_token)\n"),
  ).toEqual([{ login: "mona", env: false }]);
  expect(parseAuthStatus("You are not logged into any GitHub hosts.")).toEqual([]);
});

/** A gh signed in as AUTH_STATUS says, recording each call and the token it carried. */
function signedIn() {
  const calls: { args: string[]; token?: string }[] = [];
  const run: GhRunner = async (args, _stdin, env = {}) => {
    calls.push({ args, ...(env["GH_TOKEN"] ? { token: env["GH_TOKEN"] } : {}) });
    if (args[1] === "status") return { code: 1, stdout: AUTH_STATUS, stderr: "" };
    if (args[1] === "token") return { code: 0, stdout: `t-${args.at(-1)}\n`, stderr: "" };
    return { code: 0, stdout: '{"login":"x"}', stderr: "" };
  };
  return { calls, github: createGitHub(run) };
}

test("acts as an account by passing its token, read once, whatever case names it", async () => {
  const { calls, github } = signedIn();

  await github.as("sms-yui").rest("user");
  await github.as("SMS-YUI").rest("user");
  await github.as("smsunarto").rest("user");

  expect(calls.map((call) => [call.args.slice(0, 2).join(" "), call.token])).toEqual([
    ["auth status", undefined],
    ["auth token", undefined],
    ["api user", "t-sms-yui"],
    ["api user", "t-sms-yui"],
    ["auth token", undefined],
    ["api user", "t-smsunarto"],
  ]);
  expect(calls[1]?.args).toEqual([
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    "sms-yui",
  ]);
});

test("refuses an account gh is not signed in to, and anything that could read as a flag", async () => {
  const { calls, github } = signedIn();

  await expect(github.as("old-bot").rest("user")).rejects.toThrow(
    "@old-bot is not signed in to GitHub CLI on the bb server. Run `gh auth login`.",
  );
  expect(() => github.as("--hostname=evil")).toThrow("not a GitHub login");
  expect(calls.some((call) => call.args[1] === "token")).toBe(false);
});

test("a token GitHub refuses is read again on the next call", async () => {
  let refused = true;
  const tokens: string[] = [];
  const github = createGitHub(async (args, _stdin, env = {}) => {
    if (args[1] === "status") return { code: 0, stdout: AUTH_STATUS, stderr: "" };
    if (args[1] === "token") {
      tokens.push(args.at(-1) ?? "");
      return { code: 0, stdout: "t\n", stderr: "" };
    }
    if (refused && env["GH_TOKEN"]) {
      refused = false;
      return { code: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  });

  await expect(github.as("smsunarto").rest("user")).rejects.toThrow("not signed in");
  await github.as("smsunarto").rest("user");

  expect(tokens).toEqual(["smsunarto", "smsunarto"]);
});

test("an account that signs out is not acted as again, though its token was read", async () => {
  let now = 0;
  let status = AUTH_STATUS;
  const calls: string[] = [];
  const github = createGitHub(
    async (args, _stdin, env = {}) => {
      calls.push(env["GH_TOKEN"] ? `${args.join(" ")} as ${env["GH_TOKEN"]}` : args.join(" "));
      if (args[1] === "status") return { code: 0, stdout: status, stderr: "" };
      if (args[1] === "token") return { code: 0, stdout: `t-${args.at(-1)}\n`, stderr: "" };
      return { code: 0, stdout: "{}", stderr: "" };
    },
    () => now,
  );
  await github.as("sms-yui").rest("user");

  // `gh auth logout --user sms-yui`, which leaves the token valid on GitHub.
  status = AUTH_STATUS.replace(/ {2}✓ Logged in to github\.com account sms-yui[^\n]*\n/, "");
  now = 60_000;

  await expect(github.as("sms-yui").rest("user")).rejects.toThrow(
    "@sms-yui is not signed in to GitHub CLI on the bb server.",
  );
  expect(calls.filter((call) => call.startsWith("api"))).toEqual([
    "api user --method GET as t-sms-yui",
  ]);
});

test("the bb server's own GH_TOKEN account is acted as with that token, not a stored one", async () => {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const github = createGitHub(async (args, _stdin, env = {}) => {
    calls.push({ args, env });
    if (args[1] === "status") {
      return {
        code: 0,
        stdout: [
          "github.com",
          "  ✓ Logged in to github.com account ci-bot (GH_TOKEN)",
          "  - Active account: true",
          "  ✓ Logged in to github.com account smsunarto (keyring)",
          "  - Active account: false",
        ].join("\n"),
        stderr: "",
      };
    }
    if (args[1] === "token") return { code: 0, stdout: "t-stored\n", stderr: "" };
    return { code: 0, stdout: "{}", stderr: "" };
  });

  expect(await github.accounts()).toEqual(["ci-bot", "smsunarto"]);
  await github.as("ci-bot").rest("user");
  await github.as("smsunarto").rest("user");

  expect(calls.slice(1).map(({ args, env }) => [args.slice(0, 2).join(" "), env])).toEqual([
    ["api user", {}],
    ["auth token", {}],
    ["api user", { GH_TOKEN: "t-stored" }],
  ]);
});

test("an Enterprise Managed User is read and acted as by its whole login", async () => {
  const calls: string[][] = [];
  const github = createGitHub(async (args) => {
    calls.push(args);
    if (args[1] === "status") {
      return {
        code: 0,
        stdout: "github.com\n  ✓ Logged in to github.com account mona-cat_octo (keyring)\n",
        stderr: "",
      };
    }
    if (args[1] === "token") return { code: 0, stdout: "t\n", stderr: "" };
    return { code: 0, stdout: "{}", stderr: "" };
  });

  expect(await github.accounts()).toEqual(["mona-cat_octo"]);
  await github.as("mona-cat_octo").rest("user");
  expect(calls[1]).toEqual([
    "auth",
    "token",
    "--hostname",
    "github.com",
    "--user",
    "mona-cat_octo",
  ]);
});

test("a token replaced by signing in again is used once the accounts are read again", async () => {
  let now = 0;
  let token = "t-old";
  const used: string[] = [];
  const github = createGitHub(
    async (args, _stdin, env = {}) => {
      if (args[1] === "status") return { code: 0, stdout: AUTH_STATUS, stderr: "" };
      if (args[1] === "token") return { code: 0, stdout: `${token}\n`, stderr: "" };
      used.push(env["GH_TOKEN"] ?? "");
      return { code: 0, stdout: "{}", stderr: "" };
    },
    () => now,
  );

  await github.as("smsunarto").rest("user");
  token = "t-new";
  await github.as("smsunarto").rest("user");
  now = 60_000;
  await github.as("smsunarto").rest("user");

  expect(used).toEqual(["t-old", "t-old", "t-new"]);
});

test("the accounts list is read again after a minute", async () => {
  let now = 0;
  let reads = 0;
  const github = createGitHub(
    async () => {
      reads++;
      return { code: 0, stdout: AUTH_STATUS, stderr: "" };
    },
    () => now,
  );

  await github.accounts();
  await github.accounts();
  now = 60_000;
  await github.accounts();

  expect(reads).toBe(2);
});

test("no signed-in account reads as unauthenticated, and a missing gh as missing", async () => {
  const none = createGitHub(async () => ({
    code: 1,
    stdout: "",
    stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
  }));
  await expect(none.accounts()).rejects.toMatchObject({ code: "unauthenticated" });

  const missing = createGitHub(async () => ({ code: 127, stdout: "", stderr: "ENOENT: gh" }));
  await expect(missing.accounts()).rejects.toMatchObject({ code: "gh-missing" });
});
