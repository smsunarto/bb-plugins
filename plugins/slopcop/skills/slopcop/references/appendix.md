# Shared appendix: how to search the codebase before you comment

This applies to every one of the five profiles. The single most common theme across all of them is *"is this already implemented somewhere?"* and *"is this actually used?"* — and both are answerable from the repo. A reviewer who only reads the diff will systematically miss them.

**Ground rules.** Use the orchestrator's shared worktree at the PR head. Read the **base** revision (the code *before* this change) with `git show <base>:<path>` and search it with `git grep <pattern> <base> -- <paths>`; ordinary file reads see head, not base. Never read the PR itself, its later commits, or anyone else's review. Every claim you make must cite a concrete `path:line` you actually opened — if you can't cite it, downgrade the comment to a question ("double check we don't already have something for this?").

## A. Finding prior art (before accepting any new helper, hook, component, type, constant, endpoint, cache, or script)

Do all of these before concluding "this is new":

1. **Search the concept, not the identifier.** The existing thing almost never shares the PR's name. For a new retry/backoff wrapper, search the *behaviour*: `rg -in 'retry|backoff|attempt' <dir of the component being changed>`. For a new "get sessions for user" helper, search `rg -in 'sessions?.*(for|by)_?user|user_.*sessions'`.
2. **Try 3+ query shapes** — singular/plural, camelCase/snake_case, verb/noun, and the domain word alone (`org`, `account`, `session`, `secret`), plus definition-form variants: `rg -n 'def .*dedupe|dedup.*rows'`.
3. **Search the definition forms, not just usages:** `rg -n 'def <noun>|class <Noun>|const <noun> =|export function <noun>|fn <noun>'`.
4. **Search the layer that is supposed to own it** before the layer the PR touched: the shared models/utils package, the design system, `libs/`, the app's `utils/`/`hooks/`/`types.py`, and any shared crates/packages for other languages.
5. **Read the thing being extended, and its base.** Open the component/class/module the diff modifies and skim its full API — most "why didn't you use the existing one" comments come from the file *next to* the diff, or from the framework underneath it (the vscode base widgets, react-query, SQLAlchemy, FastAPI dependencies, nivo/recharts). Ask "does the base already support this?" before "should we add this?".
6. **Look for the second call site.** If the diff adds a helper, grep a distinctive 3–5 token fragment of its body (an unusual default, a format string, an error message) to find the copy that already exists elsewhere. Duplicated logic is the finding, even when neither copy is "wrong".
7. **`ls` the directory** the new file lands in and read the sibling module's exports. A new file in a directory that already has an obvious home is itself the comment.
8. **Check the conventions files** for a rule the PR is re-inventing or violating: `AGENTS.md`, `REVIEW.md`, `SECURITY_MODEL.md`, `.agents/skills/*/SKILL.md`, and any local `README.md`.

Comment shape when you find it: name the existing thing with its path ("`<path>` already has a helper for this"), and ask for reuse/sharing rather than a second implementation. When two surfaces will now diverge (webapp vs ACP/Windsurf, Python vs Rust), say so explicitly.

## B. Finding unused / dead code

1. **Count real references.** Definition + tests don't count: `rg -n '\bsymbol\b' --glob '!**/node_modules/**' -g '!**/*test*'`. Zero non-definition hits ⇒ dead.
2. **Distinguish *who* references it.** "Referenced only by one-off scripts or its own siblings, never by product code, no route, no test" is the shape of a dead path that a PR shouldn't extend. Say "this is kinda dead, let's not maintain it" instead of reviewing the new code on its merits.
3. **Rule out dynamic references before you call it dead:** string-keyed registries and dispatch tables, `getattr`/`__all__`/`globals()`, route and CLI-command tables, DI containers, Alembic revision graphs, feature-flag names, protobuf/codegen output, barrel `index.ts` re-exports, and CI/workflow yaml. Grep the bare name as a string too: `rg -n "'<name>'|\"<name>\""`.
4. **Audit the diff's own additions for deadness.** A new export with no importer, a new parameter/flag nothing sets, a new column nothing reads, a new config key nothing consumes, a `Literal` member nothing produces — all are comments. Grep for *readers*, not just writers.
5. **Audit the diff's own deletions.** If the PR removes a function, comment, endpoint, or branch, grep for surviving callers and for whether the behaviour moved somewhere else; if it didn't, ask why it was removed.
6. **Check for the leftover half of a migration:** old and new code paths both present, a shim with one caller, a deprecated model field still written, an unused legacy branch behind a flag that is now permanently on.

## C. Calibration

- A failed search is weak evidence. State what you searched. Phrasing: "I looked for X and Y and didn't find one — double check, but I think this duplicates `<path>`" is right; a flat assertion that no helper exists is how these comments turn into false positives.
- Don't turn a search into a refactor request that dwarfs the PR. If reuse is a bigger change than the PR itself, say "not now, but let's not add a third copy".

## D. Anticipation: simulate the consumer, count the cardinality

Most "how did the human see that coming?" comments are one of these mechanical checks, not clairvoyance:

1. **Simulate one step of actual use.** For every new capability, walk through the first real user/agent actually using it end to end. What does the consumer *do next* with the value it got, and is the piece it needs for that step present? (Given a list of IDs — can it resolve them to names? Given a token — can it refresh it? Given an event — can it correlate it back?) A feature that compiles but can't complete its own second step is the comment.
2. **Count the cardinality of everything that scales with a customer.** For every value interpolated into a prompt, payload, log line, query result, or loop: how big is it at the largest org/account/enterprise? Lists of channels, users, repos, sessions, rows — assume thousands, then ask what happens (token explosion, N+1, unbounded response, job that never finishes). Do this for prompt/payload contents, not just DB queries.
3. **Ask which axis the next requirement varies along.** New aggregations, settings, limits, and reports usually get asked for one level up or down within a release or two: org → account/enterprise, single-customer → per-customer, one workspace → many, current cycle → arbitrary cycle. Read the repo's data-model docs (`SECURITY_MODEL.md`, knowledge notes) and flag when the design hard-codes the axis: "this is org-level — do we also want the account-level version?" Phrase it as a flag, not a demand ("not sure if you've thought of that but just to flag").
4. **Do one micro-perf pass over new hot-path code.** Pops/inserts at the front of a list in a loop, repeated calls to a helper that could return both values at once, per-item queries — small, but reviewers reliably catch them and so should you.
5. **Then prune.** Anticipation multiplies output. Re-read your list and delete anything you wouldn't defend out loud: speculative product features, taste-only restyling, duplicates of another comment on a different line.
