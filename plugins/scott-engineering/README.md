# Scott Engineering

Scott's engineering workflows, derived from his pstack fork, with native Arena and independent review in BB. One plugin owns the tools, worker routing, composer banner, workflow skills, and shared engineering principles.

Ask for Arena in a BB thread. The agent calls `scott_engineering_arena_start` and emits an embedded summary showing candidates, the judge, synthesis, verification, and round history. Workers and reviewers run in hidden threads; clicking one opens it, and its header links back to the main thread. Stop Arena cancels the run independently of the main chat.

A run frames the task, launches one Claude and one Codex candidate on identical prompts, cross-judges their completed outputs, synthesizes the best parts, and verifies the combined result before automatically integrating it. There are at most three total rounds. Host-disconnection recovery permits three consecutive retries with increasing delays; checks run in the synthesis worker using its inherited execution permissions. Runs and round counts survive restarts; the plugin reconciles existing workers rather than launching duplicates.

## Independent review

Reviews run automatically at implementation handoff and before consequential design decisions, unless the user skips them. Each review asks Claude and Codex independently; the parent fixes accepted findings and verifies the changes unless the user explicitly says not to modify. Findings inform the lead's judgment; they do not gate publication. The [review workflow](skills/review/SKILL.md) owns the trigger, scope, synthesis, and fix policy.

Use `/review`, or the `scott_engineering_review_start` and `scott_engineering_review_context` tools. The CLI equivalents are `bb scott-engineering review-start` and `review-context`. BB delivers plain-language findings to the parent; retrieve a reply with `bb thread output <thread-id>`. Pin implementation reviews to a named GitButler branch or explicit base/head; combined workspace commits are rejected. The composer banner shows current and finished reviews, with navigation to each reviewer and back to the main thread.

Reviewers receive pinned-context tools only. Arena workers receive their Arena assignment tools only. Neither can launch nested workflows. Arena continues to require an explicit request or an authorized Architect workflow.

Reviews are ordinary BB subthreads. BB owns their lifecycle, retries, completion notifications, and conversation history. The plugin only launches reviewers, pins their source inputs, and displays their native status. It has no review result cache, recovery service, or data migration. Existing reviewer conversations remain available in BB. Disable the old Review plugin when using Scott Engineering.

For integrations such as Game Studio, a snapshot reviewer has origin `scott-engineering` and `reviewRun` metadata in that plugin's namespace. Arena workers use `arena` metadata and do not qualify for reviewer-only exemptions. The banner also recognizes old `review` threads for navigation.

## Requirements

Native Arena currently needs a ready Git project that allows BB-managed worktrees and has both Claude Code and Codex configured. Repositories requiring a canonical checkout or exclusive Unity/editor leases should continue using their existing authorized workflow. Architect and Blast Radius route to the native contract when its tools are available; native routing instructions take precedence over an older provider-installed copy. Other bundled skills retain their original behavior.

Source checkouts may contain uncommitted work. Arena snapshots that work using a private Git index. Candidate and synthesis worktrees start from the same pinned snapshot. Preparation merges against ongoing work. The synthesis worker runs the framing commands on that combined tree through its normal execution tools. Checks must leave nonignored files unchanged (use check-only lint and format modes); ignored build output is allowed. Integration checks both trees again and applies only a passing result. Conflicts and concurrent edits preserve the working files and consume a round rather than overwriting them.

Applying the patch and recording its receipt form a commit point: Stop cancels before that point, or reports the completed integration afterward. An interrupted apply whose outcome cannot be proven is reported for inspection rather than retried. Workers use lifecycle ownership without parent-chat notifications, so their turns do not wake the main chat.

The launching thread alone receives status and control tools. Worker tools expose only their assignment. The embedded controls run as the authenticated BB user; candidate blinding is workflow isolation, not a security boundary against that user or shared filesystem access.

Outputs remain uncommitted. Candidate worktrees and private `refs/arena/` snapshots retain artifacts for inspection. The plugin does not push or open a PR. This first version does not automatically remove retained environments.

## Commands and settings

- `bb scott-engineering start --task '...' --request-id <stable-id>` launches or recovers a launch.
- `bb scott-engineering status --run <id>` reads an owned run.
- `bb scott-engineering stop --run <id>` stops it.
- `bb scott-engineering principle` lists shared principles; add `--name grug-brain` to read one or `--name index` for workflow routing and principle triggers.
- `reviewClaudeModel` and `reviewCodexModel` select reviewers.
- `claudeModel` and `codexModel` select the two Arena model seats. Defaults follow the fork. Both use xhigh reasoning; Codex uses fast service.

The tools and prompts are editable under `instructions/`. Other skills and their references are bundled under `skills/` and `references/`. Engineering principles live in the shared `references/principles/` directory. The `principle` command reads them from the installed plugin, independently of any workflow skill or checkout path, without adding skill catalog entries. The plugin owns workflow routing and principle triggers in `instructions/engineering-guidance.md`; shared dotfiles agent instructions no longer carry these rules. The overlapping dotfiles package has been removed.
