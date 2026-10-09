Review pull request {{owner}}/{{repo}}#{{number}} and report every actionable finding to the Code Review panel.

- Title: {{title}}
- URL: {{url}}
- Base: {{baseBranch}} at `{{baseRefOid}}`
- Head: {{branch}} at `{{headRefOid}}`

This is a read-only review. Do not modify files, create commits, push branches, post or reply to comments on GitHub, approve, or request changes, and do not delegate the review to another agent. The person who asked for it reads your findings and decides what to post.

## Get the change

Fetch the pull request's head and base, then find the commit the change branches from. Run these from the repository, exactly as quoted:

{{fetch}}

If the remote is not named `origin`, use the remote that points at github.com/{{owner}}/{{repo}}.

{{workspace}}

Review `git diff <merge-base> {{headRefOid}}`: what would merge, not a diff against the tip of the base branch.

## Review the change

1. Read the applicable `AGENTS.md` instructions.
2. Inspect the complete diff and enough surrounding code to understand each changed path.
3. Identify concrete regressions introduced by the change. Continue through the whole diff after finding the first issue.
4. Check the relevant tests and call sites to confirm that each finding is real and actionable.

Flag an issue only when all of these are true:

- It affects correctness, security, performance, or maintainability in a meaningful way.
- It is discrete and actionable.
- It was introduced by this pull request.
- The affected scenario or call path can be demonstrated from the code.
- The author would probably fix it if they knew about it.

Do not flag speculative concerns, pre-existing problems, intentional behavior changes, or style nits that do not obscure the code.

Priorities:

- `P0`: universal release blocker or critical failure.
- `P1`: urgent defect that should be fixed next.
- `P2`: ordinary defect that should be fixed.
- `P3`: low-impact issue that is still worth fixing.

## The reviewer's instructions

{{reviewInstructions}}

## Report

Call `code_review_report_findings` exactly once, after the review, with a short overall summary and every finding. With no qualifying findings, call it with an empty `findings` list. Do not invent a finding to fill the result. For each finding:

- `path` is the file's path in the repository at the head commit.
- `line` is the last line of the smallest range that shows the issue, numbered in the head version of the file. Keep the range inside the diff so the comment can sit on it.
- `side` is `RIGHT`. Use `LEFT`, with line numbers from the base version, only when the issue is about deleted code.
- `startLine` is the first line of a multi-line range. Leave it out for a single line.
- `title` is an imperative sentence without the priority tag.
- `body` is one short paragraph explaining the affected scenario and why the behavior is wrong.

Then reply with the findings first, ordered by severity, one entry per issue in this form, followed by its paragraph:

`[P1] Imperative finding title — path/to/file.ts:42`

If there are none, say `No findings.` After the findings, add a brief overall assessment and mention any material test gaps or residual risks.
