# 🚨 SlopCop

Forked from [SawyerHood/sawyer-plugins](https://github.com/SawyerHood/sawyer-plugins/tree/d3424f24e2cebe91da4e72cb38feb023da808922/plugins/slopcop) at `d3424f24e2cebe91da4e72cb38feb023da808922`. Copyright and MIT license retained in [LICENSE](./LICENSE). Local packaging uses `@get-bb/plugin-sdk` at this repository's SDK version.
A [BB](https://github.com/ymichael/bb) plugin that handles new GitHub issues and reviews pull requests.

Define **rules** with a prompt, repository, triggers, and conditions. SlopCop watches
GitHub, dispatches a BB agent, and verifies its response with the `gh` CLI. A rule can
listen for new issues, ready pull requests, new commits, or any combination.

```
GitHub  ←(gh)—  watcher  →  rule matcher  →  dispatcher  →  BB agent
                   │                                          │
             plugin SQLite  ←—— verified runs ——  gh issue / gh pr
```

## Install

Run these commands on the machine hosting the BB server. The repository uses Bun workspaces, so build its framework before installing from the local checkout. BB's managed Git installer uses npm and cannot install the `workspace:*` dependency directly.

Requires BB ≥ 0.47.0 and an authenticated [`gh`](https://cli.github.com) on the machine
running the BB server.

```sh
git clone https://github.com/smsunarto/bb-plugins.git
cd bb-plugins
bun install
bun run build:framework
bb plugin install ./plugins/slopcop
```

For automatic organization-member reviews, set `--trust org_members`. This admits `OWNER` and `MEMBER` authors and excludes outside collaborators. Rules target one repository each: enroll every repository you want reviewed.

Comment triggers deliberately use the requester's trust instead of the PR author's. Set `--requester-trust org_members` to restrict requesters too. To exclude external PRs entirely, use only `ready_for_review,new_commits` triggers.

## Quick start

New rules start in **shadow mode**: they run the full review and store the body, but
post nothing. Read the result, then promote to live.

```sh
bb slopcop rules add \
  --name security-sweep \
  --repo owner/repo \
  --project my-project \
  --paths "src/auth/**,src/payments/**" \
  --prompt "Review the diff for auth and payment issues. Post findings with gh pr review --comment."

bb slopcop check security-sweep 482   # would it match? if not, exactly why not
bb slopcop dispatch security-sweep 482
bb slopcop show                       # the review it would have posted
bb slopcop rules edit security-sweep --live
```

Listen for new bug reports with the same rule system:

```sh
bb slopcop rules add \
  --name issue-triage \
  --repo owner/repo \
  --project my-project \
  --trigger new_issue \
  --label bug \
  --prompt "Triage the report. Ask for missing reproduction details and post the response."
```

The first issue poll records the open backlog. It does not dispatch agents for it.
Later issues dispatch once. A full review queue delays the event until a later poll.
The default trust gate handles only issues from repository members and collaborators.

To put all new review threads in one BB section, set its name or ID:

```sh
bb plugin config slopcop set defaultThreadSection "Automated reviews"
```

Clear the setting to create review threads without a section.

## Design notes

Three decisions do most of the work.

### The trust gate stops it running strangers' code

Reviewing a PR means the agent can run `gh pr checkout` on that branch and read the diff
into its own prompt. For an untrusted PR that is arbitrary code execution plus a prompt
injection surface, so rules default to **write access only**.

GitHub's `authorAssociation` is the signal, and its naming is a trap: **`CONTRIBUTOR`
means "has had a commit merged before", not write access.** A literal "contributors
only" filter still runs on a drive-by who landed one typo fix a year ago. Only
`OWNER` / `MEMBER` / `COLLABORATOR` imply write access, so only those are trusted by
default. `--trust org_members` narrows this to `OWNER` / `MEMBER`, excluding outside collaborators. `--trust past_contributors` and `--trust anyone` exist and are named honestly.
The same gate protects issue rules because issue text is also an untrusted prompt source.

Note that BB's permission modes are `full`, `auto`, and `accept-edits` — **none is
read-only**. There is no "run the agent sandboxed" option, so the trust gate is the
real protection rather than one layer of several.

### Comments are identifiable, and verified against GitHub

Every posted body carries a visible header so humans know it is a bot and which rule
wrote it, plus a hidden marker so SlopCop can find its own comments later:

```markdown
🚨 **SLOP COP** 🚨 · `security-sweep`

Three findings, one blocking…

<!-- slopcop:rule=security-sweep run=run_01J7X sha=a1b2c3d kind=summary -->
```

When the review thread finishes, SlopCop **does not trust the agent's transcript**. It
polls the applicable GitHub comment surfaces and matches on the marker. Pull request
runs use issue comments, inline comments, and review bodies. Issue runs use issue
comments. A run that claims success but posted nothing
is reported as `no_comment`, not as a success. If the header is present but the marker
is missing, the comment is still attributed — and flagged as prompt drift.

### Shadow mode makes a prompt change safe to test

A rule's prompt is the whole product, and prompts drift. Shadow mode runs the real
review or issue response against a real target. It stores the exact body without a
GitHub write, so a prompt change can be tested before it is visible to your team.

## Running under a bot identity

By default SlopCop reads and posts as whoever `gh` is logged in as — you. Point the
`botGhPath` setting at a wrapper that exports a bot `GH_TOKEN` and execs `gh`, and the
poller, the verifier, and the spawned review agent all switch to that identity. Your own
`gh` login is untouched, because the token never leaves the wrapper's process tree. The
agent is told the command name, never a token.

`scripts/slopcop-gh` is that wrapper for a GitHub App. It mints an installation token,
caches it in `~/.slopcop/token.cache.json` until ten minutes before expiry, and execs
`gh`. Any wrapper works; the plugin only cares that the command behaves like `gh`.

On the GitHub side. Own the app at the organization, not at a personal account —
an app owned by a person dies with that person's access:

1. Open `https://github.com/organizations/<org>/settings/apps/new`.
2. Clear the **Webhook → Active** checkbox. SlopCop polls, so it needs no webhook.
3. Grant repository permissions: Pull requests **Read and write**, Issues
   **Read and write**, Contents **Read-only**, Metadata **Read-only**.
4. Create the app. Record the App ID. Generate a private key and save the `.pem` file.
5. Install the app on every repo a rule watches. The poller reads through the same
   identity, so a missing installation fails the poll for that repo.
6. Record the installation ID from the install URL.

`gh` cannot create or install an app — neither action has a REST endpoint that a user
token can call. It can do everything after that, because `gh api` respects an explicit
`-H Authorization`:

```sh
gh api -H "Authorization: Bearer $JWT" /orgs/<org>/installation --jq .id
```

To skip the permissions form, use the [app manifest flow][manifest] instead of step 1.
You approve one browser page, then `gh api -X POST /app-manifests/$CODE/conversions`
returns the App ID and the private key in its response body.

[manifest]: https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest

On this machine:

```sh
mkdir -p ~/.slopcop && chmod 700 ~/.slopcop
mv ~/Downloads/slopcop.*.private-key.pem ~/.slopcop/slopcop.private-key.pem
chmod 600 ~/.slopcop/slopcop.private-key.pem
cat > ~/.slopcop/app.json <<'JSON'
{ "appId": "123456", "installationId": "78901234",
  "privateKeyPath": "~/.slopcop/slopcop.private-key.pem" }
JSON
cp scripts/slopcop-gh ~/.slopcop/slopcop-gh
~/.slopcop/slopcop-gh slopcop-login       # expect "<app-slug>[bot]"
```

An installation token is not a user, so `gh api user` returns 403 under the wrapper.
GitHub publishes no whoami for such a token. `slopcop-login` derives the bot login from
the app slug instead, and `authenticatedLogin()` falls back to it. Without that, the
account guard in `verifyLive` would disarm and count anyone's comment as possibly ours.

Then set `botGhPath` to `~/.slopcop/slopcop-gh` and check `bb slopcop status`.

Two consequences worth knowing:

- Comments post as `your-app[bot]`, so `--request-changes` now works on your own PRs.
  GitHub blocks that only when the reviewer is the PR author.
- The agent runs as your Unix user, so it can read the key if it tries. A separate OS
  user or a container is the only real isolation.

## Commands

|                                                           |                                                 |
| --------------------------------------------------------- | ----------------------------------------------- |
| `bb slopcop rules`                                        | List rules                                      |
| `bb slopcop rules add\|edit <rule>`                       | Create or update (see flags below)              |
| `bb slopcop rules enable\|disable\|rm <rule>`             | Toggle or delete                                |
| `bb slopcop check <rule> <number> [--issue]`              | Dry run — match, or the exact reason it did not |
| `bb slopcop dispatch <rule> <number> [--issue] [--force]` | Run now                                         |
| `bb slopcop runs [--rule <r>] [--limit N]`                | Recent runs                                     |
| `bb slopcop show [run-id]`                                | A run and the review body it produced           |
| `bb slopcop verify [run-id]`                              | Re-check a live run's comments against GitHub   |
| `bb slopcop status`                                       | gh auth, watched repos, poll interval           |

Plugin settings: `defaultThreadSection` accepts a BB thread section name or ID.
SlopCop fails a run with a clear error if that section no longer exists. `botGhPath`
switches every GitHub call to a bot identity — see above.

Rule flags: `--name --repo --project --provider --model --reasoning --permission
--prompt --paths --base --label --skip-label --trust --requester-trust --dedupe
--strategy --trigger --keyword --live --shadow --disabled --hidden --visible`.
Add `--json` to any command.

An issue-only rule selects issues automatically for manual commands. Use `--issue` for
a rule that listens to both target types.

## Rules

Exclude specific PR authors in the rule editor's **Exclude PR authors** field, or from the CLI:

```sh
bb slopcop rules edit <rule> --exclude-author "username,dependabot[bot]"
bb slopcop rules edit <rule> --exclude-author "" # clear the exclusion list
```

Usernames match case-insensitively and may include `@`. The list applies to PRs, including comment-triggered reviews; issue authors are unaffected. Editing the list replaces it. Manual `--force` retains its existing behavior of overriding rule filters.

| Field             | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `repo`            | One `owner/repo` per rule                                                                     |
| `triggers`        | `ready_for_review`, `new_commits`, `new_issue`, `pr_description_matches`, `comment_matches`   |
| `commentKeywords` | Case-insensitive literal tokens used by description and comment triggers                      |
| `conditions`      | Labels, author, and title apply to all targets. Paths, base, and diff size apply only to PRs. |
| `authorTrust`     | `org_members`, `write_access` (default), `past_contributors`, `anyone`                        |
| `requesterTrust`  | Who can request a review through a comment; `write_access` by default                         |
| `mode`            | `shadow` (default) or `live`                                                                  |
| `dedupe`          | `once_per_pr`, `once_per_head_sha`, or `once_per_trigger_event`                               |
| `visibility`      | `visible` (default) or `hidden` review threads                                                |

### Keyword-triggered reviews

Use a keyword trigger to run a rule only after an explicit request:

```sh
bb slopcop rules add \
  --name requested-review \
  --repo owner/repo \
  --project <bb-project-name> \
  --trigger comment_matches,pr_description_matches \
  --keyword "@slopcop" \
  --requester-trust write_access \
  --dedupe once_per_trigger_event
```

Keywords use case-insensitive, complete-token matches. `@slopcop-test` does not
match `@slopcop`. General PR comments and inline review comments can request a
review. The bot ignores its own comments. An allowed commenter can request a
review on any open PR, regardless of the PR author's trust level.

The description trigger checks a new ready PR. It also checks a draft when the
author marks it ready. Later description edits do not trigger a review. Comment
polling starts when the trigger becomes active, so old comments do not run it.

### Run statuses

`shadowed` · `commented` · `commented_partial` / `commented_unmarked` /
`commented_unattributed` (posted, attribution degraded) · `no_comment` (finished
without posting) · `skipped` (matched nothing, e.g. blocked by the trust gate) ·
`failed`.

## Development

```sh
# From the repository root:
bun install
bun run --cwd plugins/slopcop test
bun run --cwd plugins/slopcop typecheck
bb plugin install ./plugins/slopcop
bb plugin dev ./plugins/slopcop
```

The interesting logic is pure and unit-tested: `lib/matcher.ts` (globs, trust gate,
trigger edges), `lib/marker.ts` (header/marker attribution), `lib/verify.ts` (the two
verification modes). `server.ts` is mostly wiring.

Two things worth knowing before changing storage or GitHub reads:

- **Migrations are keyed by statement index.** `MIGRATIONS` in `lib/db.ts` is strictly
  append-only — an inserted statement inherits an already-applied index and is silently
  skipped.
- **`gh pr list --json` has no `authorAssociation` field.** It only exists in the REST
  API, which is why all PR reads go through `gh api`.

## License

MIT
