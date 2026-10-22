import { expect, test } from "bun:test";
import type { Check } from "../../shared/schema.ts";
import { fixChecksPrompt, localReviewPrompt, reviewPrompt } from "./prompts.ts";
import type { PrHead } from "./pull-request.ts";

const PR: PrHead = {
  ref: { owner: "cli", repo: "cli", number: 9000 },
  number: 9000,
  title: "proof of concept for flag-level disable auth check",
  url: "https://github.com/cli/cli/pull/9000",
  headRefName: "scott/it's;ok",
  baseRefName: "trunk",
  headRefOid: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
  baseRefOid: "28c4d3075b5916acdb6974a7e4f5c49d2c274a86",
  isFork: false,
};

test("a review prompt names the pull request, fetches it, and quotes branch names", () => {
  const prompt = reviewPrompt(PR, { reused: false, instructions: "" });

  expect(prompt).toStartWith(
    "Review pull request cli/cli#9000 and report every actionable finding to the Review panel.",
  );
  expect(prompt).toContain("- Head: `scott/it's;ok` at `cc36d32a212a2b8b6611fb73549fe6d04fb6ec38`");
  expect(prompt).toContain(
    "```sh\ngit fetch origin 'pull/9000/head' 'trunk'\ngit merge-base cc36d32a212a2b8b6611fb73549fe6d04fb6ec38 'origin/trunk'\n```",
  );
  expect(prompt).toContain(
    "```sh\ngit checkout --detach cc36d32a212a2b8b6611fb73549fe6d04fb6ec38\n```",
  );
  expect(prompt).toContain("## The reviewer's instructions\n\nNone.\n");
  expect(prompt).toContain("Call `code_review_report_findings` exactly once");
  expect(prompt).not.toContain("{{");
});

test("a review in someone's checkout leaves their working tree alone", () => {
  const prompt = reviewPrompt(PR, { reused: true, instructions: "Watch the auth paths." });

  expect(prompt).toContain(
    "This environment is someone's working checkout of `scott/it's;ok`, and it may hold their uncommitted or unpushed work. Do not check out, reset, stash, or clean anything.",
  );
  expect(prompt).not.toContain("git checkout --detach");
  expect(prompt).toContain("## The reviewer's instructions\n\nWatch the auth paths.\n");
});

const check = (overrides: Partial<Check>): Check => ({
  id: "run:1",
  name: "Lint",
  workflow: "CI",
  state: "failure",
  description: null,
  detailsUrl: "https://github.com/cli/cli/actions/runs/1/job/1",
  startedAt: null,
  completedAt: null,
  jobId: 1,
  ...overrides,
});

test("a fix prompt lists each check with its log, fenced so the log cannot break out", () => {
  const prompt = fixChecksPrompt(PR, [
    { check: check({}), log: { text: "```\n##[error]boom" } },
    {
      check: check({ id: "status:ci", name: "ci", workflow: null, description: "Waiting" }),
      log: { missing: "not a GitHub Actions job." },
    },
  ]);

  expect(prompt).toStartWith(
    "Fix the failing checks on pull request cli/cli#9000: proof of concept for flag-level disable auth check",
  );
  expect(prompt).toContain(
    "The pull request's branch is `scott/it's;ok`, at `cc36d32a212a2b8b6611fb73549fe6d04fb6ec38`.",
  );
  expect(prompt).toContain(
    "If a branch named `code-review/fix-9000-cc36d32` already exists, do not reuse or reset it",
  );
  expect(prompt).toContain("push it to the pull request's branch, `scott/it's;ok`.");
  expect(prompt).toContain(
    "### CI / Lint\n\nhttps://github.com/cli/cli/actions/runs/1/job/1\n\n````text\n```\n##[error]boom\n````",
  );
  expect(prompt).toContain(
    "### ci\n\nhttps://github.com/cli/cli/actions/runs/1/job/1\n\nWaiting\n\nNo log: not a GitHub Actions job.",
  );
  expect(prompt).not.toContain("{{");
});

test("a fix goes on a new local branch from the pull request ref, fork or not", () => {
  const pr = { ...PR, number: 7, headRefOid: "abcdef1234567890abcdef1234567890abcdef12" };
  for (const isFork of [false, true]) {
    const prompt = fixChecksPrompt({ ...pr, isFork }, [{ check: check({}), log: { text: "x" } }]);

    expect(prompt).toContain(
      "```sh\ngit fetch origin 'pull/7/head'\ngit switch -c 'code-review/fix-7-abcdef1' FETCH_HEAD\n```",
    );
    // Switching to the head branch itself fails where another worktree has it checked out.
    expect(prompt).not.toContain("git switch 'scott");
    expect(prompt).not.toContain("git switch -c 'scott");
  }
});

test("a branch name with backticks stays inside its inline code", () => {
  const pr = { ...PR, headRefName: "a`b", baseRefName: "`whoami`" };

  const review = reviewPrompt(pr, { reused: true, instructions: "" });
  expect(review).toContain("- Base: `` `whoami` `` at `28c4d3075b5916acdb6974a7e4f5c49d2c274a86`");
  expect(review).toContain("- Head: ``a`b`` at `cc36d32a212a2b8b6611fb73549fe6d04fb6ec38`");
  expect(review).toContain("someone's working checkout of ``a`b``, and");

  const fix = fixChecksPrompt(pr, [{ check: check({}), log: { text: "x" } }]);
  expect(fix).toContain("The pull request's branch is ``a`b``, at");
  expect(fix).toContain("push it to the pull request's branch, ``a`b``.");
  expect(fixChecksPrompt({ ...pr, headRefName: "x``y`" }, [])).toContain(
    "The pull request's branch is ``` x``y` ```, at",
  );
});

test("a branch review reads the branch from git and leaves the GitButler workspace alone", () => {
  const prompt = localReviewPrompt(
    {
      id: "f4b6d5b36a16",
      hostId: "host-1",
      machine: "builder",
      path: "/home/example/git/api",
      repoName: "api",
      repository: "acme/api",
      branch: "scott/it's;`ok`",
      status: "ahead",
      head: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
      base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parent: "scott/login-copy",
      commits: [
        {
          commitId: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
          message: "Rate-limit the login endpoint\n\n{{criteria}} stays as written.",
          authorName: "Scott",
          createdAt: "2026-10-10T09:00:00Z",
        },
      ],
    },
    "Watch the auth paths.",
  );

  expect(prompt).toStartWith(
    "Review the unpublished branch `` scott/it's;`ok` `` in `api` and report every actionable finding",
  );
  expect(prompt).toContain("- Checkout: `/home/example/git/api` on builder");
  expect(prompt).toContain(
    "- Base: `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, the head of `scott/login-copy`",
  );
  expect(prompt).toContain("- `cc36d32` Rate-limit the login endpoint\n");
  expect(prompt).toContain(
    "Review `git diff 4b825dc642cb6eb9a060e54bf8d69288fbee4904 cc36d32a212a2b8b6611fb73549fe6d04fb6ec38`",
  );
  expect(prompt).toContain("`git show cc36d32a212a2b8b6611fb73549fe6d04fb6ec38:<path>`");
  expect(prompt).toContain("- It was introduced by the change under review.");
  expect(prompt).toContain("## The reviewer's instructions\n\nWatch the auth paths.\n");
  expect(prompt).not.toContain("{{");
});
