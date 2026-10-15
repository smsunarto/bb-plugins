# Unity

Coordinate Unity Editor ownership across BB threads. Discovery groups main Editors and Multiplayer Play Mode (MPPM) clients into checkout slots. Each slot follows its canonical shared Assets workspace, independently of Editor restarts or Git branch names.

## Control an Editor

Use the `unity_manage` agent tool or these commands inside a BB thread:

```sh
bb unity manage list
bb unity manage claim --instance instance_id --mode authoring
bb unity manage command --instance instance_id --claim claim_id \
  --command editor_status
bb unity manage status --instance instance_id --claim claim_id
bb unity manage release --instance instance_id --claim claim_id
```

Keep the returned claim ID. Wait until `claim.jobId` is `null` before release. An interrupted submission stays uncertain until its owner checks native completion and reconciles it. Read the bundled `unity-editors` skill for reconciliation and orphan recovery.

- **Runtime claims** allow inspection of distinct Editors sharing one workspace.
- **Authoring claims** exclude other threads from the shared workspace. MPPM clients cannot take authoring claims.
- **Checkout slots** remain occupied when discovery loses an Editor that still has a durable claim. Slot IDs include the host and canonical workspace path.

Claims survive reloads and idle turns. They never expire automatically. Direct filesystem edits, physical input, Unity CLI calls and backend accounts still require coordination.

The published `listUnityEditors` RPC accepts `{ hostId?, threadId? }` and returns `hostId`, `instances`, `warnings`, `claims` and `slots`. Supply a host or a thread whose environment selects one. This RPC always redacts claim IDs. Each slot includes its main Editors, MPPM clients and public ownership records.

## Upgrade from earlier plugin names

Install this plugin and reload the updated `kitchen-sink` plugin. On its first operation, Unity Editors imports Kitchen Sink's durable claims into its own database. The import preserves owners, claim IDs, pending native jobs and uncertainty. Import and completion receipt commit atomically, so retries cannot resurrect released claims.

An installed Kitchen Sink must be running and expose the handoff RPC. A disabled or outdated copy blocks the transfer. After a successful transfer, Unity Editors operates independently. Keep the updated Kitchen Sink version: downgrading it would restore a separate claim manager with stale state. Kitchen Sink retains only a read-only handoff endpoint and no Unity controls.

An existing `unity-editors` installation transfers its current claims and completed Kitchen Sink migration receipt through a read-only namespace handoff. The receipt prevents released Kitchen Sink claims from being imported again. Remove the retired namespace after the transfer succeeds.

The old `bb kitchen-sink editors` command and `kitchen_sink_editors` tool move to `bb unity manage` and `unity_manage`. Update automation that names those interfaces.

## Use durable checkouts for parallel Unity work

[Popbot's durable slot design](https://github.com/proofofplay/popbot-tool/blob/main/docs/adr/0003-slot-as-durable-unit.md) keeps a checkout, its private Library cache, Editor and services together. Adopt that lifetime when preparing Unity environments: reuse a stable checkout and its cache across tasks. Keep each slot's services, ports, logs and test accounts separate. MPPM clients share a slot because they share Assets.

This plugin inventories existing slots and guards Editor operations. It does not create checkouts, switch branches, launch Editors, allocate ports or budget RAM. BB already exposes environment providers for future provisioning, so checkout lifecycle can use the SDK rather than a second environment registry.

Use existing BB environments as durable checkout identities today. New threads can reuse an environment with `threads.spawn({ environment: { type: "reuse", environmentId }, ... })`. Prefer persistent Project checkout environments for adopted warm directories: native managed worktrees can retire after their last active thread.

For automatic preparation, register a custom provider with `bb.experimental_environments.register`. Its `create`, `restore` and `remove` hooks support checkout lifecycle, cancellation and progress. Set `policy.retireGraceMs` to `null` to retain warm environments after threads archive. Explicit deletion still requests removal.

Keep editor claims separate. `experimental_claimPath` protects provisioning, then releases preparation ownership once the environment is reusable. `experimental_existingPath` can reuse an environment without running `create`. Neither grants exclusive Editor access. Keep stable slot identity in provider inputs or durable slot records: `pathKey` changes on restoration, and successful removal clears provider `resource`. Refuse explicit retirement while owned Editor work remains. These APIs exist in the repository SDK 0.5.29; lifecycle behavior was checked against the running BB 0.46.0 / SDK 0.6.37 implementation.

Keep GitButler for source control. Its [parallel-agent documentation](https://docs.gitbutler.com/ai-agents/parallel-agents) explicitly distinguishes shared branches from worktrees with isolated runtimes:

| Arrangement                      | Unity isolation                                    | Recommendation                    |
| -------------------------------- | -------------------------------------------------- | --------------------------------- |
| Applied branches in one checkout | Shared Assets, Library and Editor                  | One authoring owner               |
| Independent clones               | Separate checkout and local Git metadata           | Use for parallel authoring today  |
| Linked Git worktrees             | Separate checkout and Library, shared Git metadata | Pilot GitButler integration first |

The inspected `but 0.22.3` exposes experimental worktree management behind `worktreeManipulation`. Its linked-worktree commands and workflow differ from a normal GitButler workspace. This repository's GitButler plugin also discovers cross-machine workspaces through `gitbutler/workspace` and queues writes by checkout path, rather than Git common directory.

Independent clones fit that existing routing. Initialize GitButler separately in each clone instead of copying initialized `.git/gitbutler` state. This recommendation follows GitButler's [project identity](https://github.com/gitbutlerapp/gitbutler/blob/release/0.22.3/crates/gitbutler-project/src/project.rs#L172-L180) and [storage implementation](https://github.com/gitbutlerapp/gitbutler/blob/release/0.22.3/crates/gitbutler-project/src/project.rs#L259-L268). No multi-checkout GitButler mutation workflow was exercised during extraction.
