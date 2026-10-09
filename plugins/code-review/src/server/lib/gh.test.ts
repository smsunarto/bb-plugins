import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type RunResult, createGh, execGh, runResult } from "./gh.ts";

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
