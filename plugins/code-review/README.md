# Review

Review GitHub pull requests and committed local branches without leaving bb: an inbox of what waits on
you, each pull request's description, diff, and checks, draft comments on
any line, a one-click bb review, and **Submit review** to post it all.

It is a bb take on [Codex Code Review](https://learn.chatgpt.com/docs/code-review),
with local branch reviews alongside pull requests. Open **Review** from bb's navigation.

## Nothing posts until you submit

Draft comments are comments on your **pending review** on GitHub, the same
one github.com keeps while you review there. Only you see them, on both
sides, and **Submit review** posts every draft at once as a comment, an
approval, or a change request. **Discard drafts** deletes the pending review.
There is no local copy of a draft to fall out of step with GitHub.

## Inbox

- **Assigned to me**: a review requested from you directly, or a pull
  request assigned to you.
- **My team**: a review requested from one of your teams, and not from you.
- **Authored by me**: your open pull requests. Your own pull requests appear
  only here, even when you assigned yourself.
- **Pinned**: any pull request you pin, open or not, in pin order. A pinned
  pull request that was deleted, or that you lost access to, drops out.

The badge on **Review** in bb's navigation counts the pull requests in the
first two sections that you have not reviewed yet.

With more than one account signed in to `gh`, the inbox merges every
account's pull requests, and **Accounts** narrows it to one. A pull request
is read, drafted, and reviewed as one account: the one whose inbox listed
it, shown in its URL (`@login/owner/repo/pull/1`). **as login** in its header
switches account. An account whose token fails is named above the inbox,
and the rest still load.

**Unpublished** lists GitButler branches that have commits and no pull
request yet, from every connected machine, when the
[GitButler plugin](../gitbutler) is on. A branch opens to its commits and its
diff, and **Review with bb** reviews it like a pull request.

Tick **Reviewed** on each local file's diff. Pierre's file explorer groups
changed files by folder and opens their diffs. Reviewed
diffs collapse, and checking every file shows **Ready**. Untick a file to
reopen it. These marks are saved in bb for that branch's exact base and head
commits; a new commit or rebase starts a fresh review. bb keeps marks for
the five most recently reviewed comparisons per branch. Pull requests keep
GitHub's **Viewed** marks. **Ready** records reading progress and does not
submit a GitHub review or merge changes.

## Changes in chat

Agents can call `code_review_share_changes` with a committed GitButler branch
or GitHub pull request. Its returned `::code-review` directive renders a
compact card in the reply: changed files, line counts, review progress, and
**Review changes** to jump to the diffs on the review page. The card updates with your review
marks. When the shared branch moves, it warns and offers **Review latest
changes**.

## A pull request

The description, labels, reviewers, checks, review findings, linked bb threads,
stack, activity, and changed files share one page. The file list and review
controls stay visible as you scroll.

- **Changes**: every file's diff with review threads, drafts, and findings
  inline. Write a draft on any line or range, reply, edit or delete drafts,
  and mark files viewed, which github.com shows too. Generated files sort
  last and start folded.
- **Checks**: check runs and commit statuses on the head commit, failures
  first. **Fix** opens a new-thread composer prefilled with the failing
  checks and the end of each failed GitHub Actions job's log.

Existing links to Summary, Changes, or Checks open this page at that section.

### Previews

On **Changes**, a file a text diff cannot show well gets a preview of both
versions, read at the same commits as the diff. **Preview** and **Diff**
switch between the preview and its text, which stays the place for line
comments.

- **Images**: PNG, JPEG, GIF, WebP, AVIF, BMP, SVG, and ICO, plus TGA, TIFF,
  PSD, EXR, and HDR decoded in the browser. Compare them side by side, with a
  swipe, or as an onion skin.
- **Models**: glTF, GLB, FBX, OBJ, STL, PLY, Collada, and 3MF, orbited
  together, with mesh, vertex, triangle, and material counts. Files a model
  names, such as a `.bin`, `.mtl`, or texture, are read beside it. Draco and
  KTX2 compression are not decoded.
- **Audio, video, and fonts** play or render in the browser.
- **Unity assets** saved as text YAML (scenes, prefabs, materials,
  animations, and other `.asset` kinds) show the objects, components, and
  properties that changed. A `.meta` file shows its importer settings and
  warns when its GUID changes.
- **Git LFS**: a pointer is read through to its object. On GitHub, objects
  come from the repository's LFS storage, the pull request's fork first; an
  LFS server named in `.lfsconfig` elsewhere is not read. On an unpublished
  branch, they come from the checkout's LFS store, fetched from its remote
  when missing.

Previews read files up to 64 MiB, and Unity assets up to 16 MiB. Decoded
images stop at 8192 × 4096 pixels, or 4096 × 4096 for EXR and HDR.

## Review with bb

**Review with bb** starts a thread on bb's default agent, at high reasoning,
that reviews the pull request's head commit read-only: it does not edit,
commit, push, or comment on GitHub. It reports every finding, P0 to P3,
back to the panel with the `code_review_report_findings` tool, and the
findings show beside the diff. A finding on an older head commit is marked
stale. Asking again while a review of the same commit runs opens that review.

The thread runs in a ready bb environment already on the pull request's
branch when there is one, and then leaves its working tree alone. Otherwise
it gets a fresh worktree on the project's default machine. **Review
instructions** sets what every later review should pay attention to.

An unpublished branch is reviewed in the GitButler workspace that holds it,
since its commits are nowhere else. That review reads the branch with
`git diff` and `git show` and changes nothing in the workspace.

The prompts live in [`instructions/review-with-bb.md`](instructions/review-with-bb.md)
and [`instructions/review-local-branch.md`](instructions/review-local-branch.md),
which share [`instructions/review-criteria.md`](instructions/review-criteria.md),
adapted from Codex's own review agent. The Prompt Editor plugin can edit them.

## Requirements

- The GitHub CLI (`gh`) installed and signed in (`gh auth login`) on the
  machine running the bb server, with one account or several. Every GitHub
  call goes through it, so the plugin stores no token.
- For **Unpublished**: the GitButler plugin, and the repository's checkout
  known to bb as a project source or environment. It needs no `gh`.
- For reviews and fixes: the repository added as a bb project whose git
  remote is the GitHub repository.

## What it stores

In bb's plugin storage: local file review marks by branch and comparison, your pins and the account that pinned each, your
review instructions, and which bb threads were started for which pull
request or unpublished branch, with each review's findings. Everything else is read from GitHub when you open it.

## Development

```sh
bun install
bun run --filter '@smsunarto/bb-plugin-code-review' test
bun run --filter '@smsunarto/bb-plugin-code-review' typecheck
bun run --filter '@smsunarto/bb-plugin-code-review' check
```

The server's GitHub queries are tested against responses recorded from real
pull requests in `test/fixtures/`. Write paths are tested against a fake
`gh` (`test/fake-gh.ts`) that records the exact mutations sent.

Run the tests through the `test` script, not a bare `bun test`. The script
turns off JavaScriptCore's FTL JIT (`BUN_JSC_useFTLJIT=0`). Under Bun 1.4.2,
the app tests that open modals, run in one process, hang inside jsdom's
`getComputedStyle` and grow without bound until the machine runs out of
memory. Drop the flag once a Bun upgrade passes the full suite without it.

## License

[MIT](LICENSE)

## Review playbooks

`bb review playbook` lists the bundled global playbooks and Markdown files under the current checkout's `.agents/review/`, using each file's YAML `description` as its “when to use” guidance. Names are scoped, such as `global/correctness` and `project/networking`; `--name <listed-name>` reads one, and `--json` returns structured output.

Project playbooks can live in nested directories. Each file starts with frontmatter:

```markdown
---
description: Changes to transport, replication, or reconnect behavior.
---

# Networking

Review suggestions go here.
```

Inside a BB thread, project files are read from that thread's checkout and machine. Outside a thread, pass `--machine <id> --directory <absolute-checkout>` to include project playbooks; without them the command lists globals and explains how to load project guidance. Missing project folders are empty; malformed playbooks and read failures produce diagnostics. Project listing failures leave globals available with a diagnostic. The host file API ignores symlinked entries. Index pages default to 50 entries; use `--offset` and `--limit` to page, or JSON `nextOffset` to continue. Pages shrink when necessary to fit the CLI byte limit.

The CLI root is `review`; existing `code_review_*` agent tools retain their names.

`bb review prompt --request <text>` prints the shared reviewer brief, including the playbook pointer, followed by your request. Pass multiline requests as one quoted argument and redirect stdout to a file for `bb thread spawn --prompt-file`. The command only formats the prompt; it launches no threads.

The `review` skill is bundled here alongside the prompt command and playbooks. It owns the explicit Claude/Codex launch recipe, unique review titles, result handling, and child cleanup. The shared dotfiles instructions point authors to this skill at engineering handoff.
