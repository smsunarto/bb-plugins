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

The `unity-rampage-slot` BB environment provider reserves persistent **Rampage client** checkouts. Create warm slots from a master checkout, or register an existing independent clone. Registration verifies the Rampage markers, Unity version, private Git metadata and isolated source/cache directories.

Register a stopped checkout against its Rampage BB project:

```sh
bb unity slots register --host host_id --project rampage_project_id \
  --path /absolute/path/to/rampage-client
bb unity slots list --host host_id
```

Create the pool once from that registered master. Run creation inside a BB thread, with Unity closed and the master checkout clean:

```sh
bb unity slots create --host host_id --source master_slot_id \
  --path /absolute/path/to/rampage-slot-1 --branch scott/slot-1
bb unity slots create --host host_id --source master_slot_id \
  --path /absolute/path/to/rampage-slot-2 --branch scott/slot-2
```

Each creation makes independent Git metadata and seeds `Library` using native copy-on-write. macOS uses APFS `clonefile` through Python 3; Linux requires native reflink support. Source and destination must support cloning on the same filesystem. Unsupported cloning fails; it never falls back to a full copy or hard links. Git LFS assets hydrate from the master's local objects without network fetches. Commit and hydrate the master before seeding.

The source lease is frozen during seeding, including against its owner. Unity must remain closed throughout. The clone excludes source GitButler state, Pipeline credentials, MPPM clones, Temp and Logs. Completed creation retries preserve the slot's changed files and cache. Failed creation leaves its partial directory and a fenced host receipt for inspection; recover the source lease explicitly and choose a new destination after a partial failure.

Select `unity-rampage-slot` when creating a BB thread. Empty inputs `{}` choose an available warm slot on that host and project. Allocation reserves it atomically before readiness checks; retries keep the same slot. Released slots keep their branch, work and Library for reuse. GitButler owns later branch changes; the slot manager never stashes or resets them.

Supply `{"slotId":"slot_id"}` to select a particular slot. Adopted Project Checkout environments require this explicit selection because BB retains their existing provider identity. New slots and environments already owned by Unity support automatic selection. An attached thread can use `bb unity slots acquire --slot slot_id`.

Keep both capabilities: the slot lease protects the checkout across tasks and Editor restarts; an Editor claim protects its exact process and native jobs. Leases survive idle turns, failures, archive/delete events and plugin reloads. They never expire automatically. BB's dispatch policy remains cooperative: explicit Send-now, edited-message resend and manual compaction bypass admission hooks. Direct filesystem access and physical input cannot be intercepted; managed Editor claims still enforce slot ownership.

For handoff, finish native jobs, release every Editor claim, and close the main Editor and its MPPM clients. Preserve dirty scenes before closing. Then release the slot:

```sh
bb unity slots release --slot slot_id --lease lease_id
```

Release preserves the checkout, Library cache, dirty files and GitButler state. Any failed or interrupted readiness check quarantines the slot. Close remaining Editors and verify completion, then use `bb unity slots recover --slot slot_id --confirm --note 'Observed completion evidence'`. Another caller can recover ownership only after its owning thread is archived or deleted. An unverifiable Unity process or a remaining Unity lock blocks handoff; the plugin never kills processes or removes locks.

Use `bb unity slots retire --slot slot_id` to retire an available slot. Provider removal performs the same checks. Retirement preserves all checkout files and prevents further leases until explicit registration. The provider uses `retireGraceMs: null` and `ownsPath: false`, so BB keeps warm environments and does not run destructive checkout teardown. Editor launch and Jetstream services remain outside this lifecycle.

If you explicitly deleted its BB environment, re-register the slot and restore an existing owning thread's environment before starting another task. Registration does not revive a destroyed BB environment record.

Keep GitButler for source control. Its [parallel-agent documentation](https://docs.gitbutler.com/ai-agents/parallel-agents) explicitly distinguishes shared branches from worktrees with isolated runtimes:

| Arrangement                      | Unity isolation                                    | Recommendation                    |
| -------------------------------- | -------------------------------------------------- | --------------------------------- |
| Applied branches in one checkout | Shared Assets, Library and Editor                  | One authoring owner               |
| Independent clones               | Separate checkout and local Git metadata           | Use for parallel authoring today  |
| Linked Git worktrees             | Separate checkout and Library, shared Git metadata | Pilot GitButler integration first |

The inspected `but 0.22.3` exposes experimental worktree management behind `worktreeManipulation`. Its linked-worktree commands and workflow differ from a normal GitButler workspace. This repository's GitButler plugin also discovers cross-machine workspaces through `gitbutler/workspace` and queues writes by checkout path, rather than Git common directory.

Independent clones fit that existing routing. Initialize GitButler separately in each clone instead of copying initialized `.git/gitbutler` state. This recommendation follows GitButler's [project identity](https://github.com/gitbutlerapp/gitbutler/blob/release/0.22.3/crates/gitbutler-project/src/project.rs#L172-L180) and [storage implementation](https://github.com/gitbutlerapp/gitbutler/blob/release/0.22.3/crates/gitbutler-project/src/project.rs#L259-L268). No multi-checkout GitButler mutation workflow was exercised during extraction.
