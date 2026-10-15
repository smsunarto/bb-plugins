# Game Studio

A native BB studio for Unity projects, adapted from
[WhiteTowerAI/ohmygame](https://github.com/WhiteTowerAI/ohmygame). Keep your BB
conversation in BB’s native main chat. The Unity workflow, design document,
asset canvas, staging library, and playtest evidence live in BB’s right sidebar.

Open **Game Studio** from a thread’s panel launcher or header button.
The navigation gallery opens projects beside their native BB thread. Studio
contains no embedded chat or composer. Actions add a request to the main chat’s
native composer for you to review and send; BB owns the agent and its settings.
Select its enrolled machine and enter the absolute Unity project directory. The
connection checks `ProjectSettings/ProjectVersion.txt` and `Assets`. **New
project** creates a design workspace with your selected Editor version and
3D URP, 2D URP, or Empty template; the agent then uses Unity's actual project
creation tooling. Leave the version unset to let the agent choose through Hub.

## Work in Unity

- **Unity:** project version, discovered Editors and their ownership, and agent
  requests to connect, implement, import, or playtest. Recent requests show
  file-backed Queued, Running, Done, Failed, or Uncertain progress reported by
  the agent; a thread becoming idle does not mark work done.
- **Design:** editable Markdown documents with explicit saves and disk-conflict
  handling.
- **Canvas:** boards with draggable notes, documents, image/video/3D requests,
  audio assets, and reference connections. Save a board before requesting assets.
- **Assets:** upload to `canvas/staging`; browse imported media under
  `Assets/GameStudio`. The agent verifies and imports staged files using the
  project's established asset structure.
- **Evidence:** screenshots and recordings saved under `canvas/evidence`. Unity
  WebGL builds can also be opened through BB's leased file preview.

Image, video, and 3D generation use native agent tools: `game_studio_generate_image`,
`game_studio_generate_video`, and `game_studio_generate_3d_asset`. Read
`game_studio_canvas_context` first; `game_studio_generate_canvas_media` consumes a
saved node and its exact board revision. Defaults are Google Nano Banana 2.1
for images and Gemini Omni 1.1 Flash for video. Fal H3 Max remains an alternate
video provider; Midjourney supports images/video and Tripo P2 handles approved
image-to-geometry work. ElevenLabs and Suno remain agent workflows for audio.

Set the **Google Gemini API key** in Game Studio's secret settings. Connect Fal
with browser OAuth: `bb game-studio auth connect` returns a verification URL and
code; `bb game-studio auth poll` completes sign-in after approval. Use `status` to
inspect the account and `disconnect` to revoke authorization. Refresh tokens stay
in BB secret settings; access tokens refresh automatically before Fal work and
never belong in game files or the browser bundle. Native
Google/Fal adapters use their APIs; Midjourney/Tripo adapters run the installed
workflow CLIs on the project's host, with fixed argument lists and no shell.

Generation returns an asynchronous job in `canvas/jobs/<requestId>.json`.
Preserve `requestId` on retries. `game_studio_generation` reads status, resumes
a confirmed provider task, or stops local waiting without resubmitting it.
Stopping local waiting does not cancel a paid provider task. Unknown submission
outcomes require reconciliation before a new request. Collect status before
releasing a registered checkout; unresolved dispatches keep it reserved.
Successful outputs stay in `canvas/staging` and are cataloged when collected.
They attach to their source node only while its brief and connected design
sources are unchanged; otherwise they remain staged candidates for review.
Midjourney standard jobs yield four image candidates; the other image/video
models yield one. Asset buttons prepare a request in native BB chat for review
and do not directly start generation.

Game Studio includes Editor discovery, managed ownership, and persistent Rampage
checkout slots. Use `game_studio_manage` and `game_studio_slots`, or
`bb game-studio manage` and `bb game-studio slots`. Editor control, imports into
`Assets`, package edits, and scenario lifecycle require the agent's exact
Editor claim. The studio UI reads inventory without taking claims.

When upgrading from the separate Unity plugin, follow the environment
re-adoption procedure below before disabling it. Game Studio imports its claims, leases, and provisioning
receipts once from the old database, preserving ownership and pending jobs.
Interrupted checkout preparation remains quarantined for explicit recovery.
The provider ID remains `unity-rampage-slot`, but BB also binds environments
to their owning plugin. Existing Unity-owned environments require re-adoption.

## Files and collaboration

Design files use the upstream canvas workspace layout: `canvas/index.json`,
`canvas/boards/*.json`, `canvas/editor/*.json`, `canvas/documents/*.md`, and
`canvas/assets.json`. Editor layout stays separate from board content. Existing
project files, including `AGENTS.md`, are preserved. Save operations compare
file hashes and reject stale writes, retaining the editor draft.
Agents keep independent progress files for accepted requests at
`canvas/requests/<id>.json`; drafts create no request history. The studio reads
up to 1,000 request files and shows the newest five valid records.

Each game is bound to its BB project, machine, and directory. A linked agent
thread must use that same checkout; another worktree does not share the studio's
files. BB's remote file APIs serve media on the correct enrolled machine.

## Development

From this repository, use the workspace dev loop and isolated verification
workflow. This plugin's checks are `bun run typecheck`, `bun run test`,
`bun run check`, and `bun run build` from its directory.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the pinned upstream source
and [LICENSE](LICENSE) for Apache-2.0 terms.

## Editor ownership and checkout slots

Coordinate Unity Editor ownership across BB threads. Discovery groups main Editors and Multiplayer Play Mode (MPPM) clients into checkout slots. Each slot follows its canonical shared Assets workspace, independently of Editor restarts or Git branch names.

## Control an Editor

Use the `game_studio_manage` agent tool or these commands inside a BB thread:

```sh
bb game-studio manage list
bb game-studio manage claim --instance instance_id --mode authoring
bb game-studio manage command --instance instance_id --claim claim_id \
  --command editor_status
bb game-studio manage status --instance instance_id --claim claim_id
bb game-studio manage release --instance instance_id --claim claim_id
```

Keep the returned claim ID. Wait until `claim.jobId` is `null` before release. An interrupted submission stays uncertain until its owner checks native completion and reconciles it. Read the bundled `unity-editors` skill for reconciliation and orphan recovery.

- **Runtime claims** allow inspection of distinct Editors sharing one workspace.
- **Authoring claims** exclude other threads from the shared workspace. MPPM clients cannot take authoring claims.
- **Checkout slots** remain occupied when discovery loses an Editor that still has a durable claim. Slot IDs include the host and canonical workspace path.

Claims survive reloads and idle turns. They never expire automatically. Direct filesystem edits, physical input, Unity CLI calls and backend accounts still require coordination.

The published `listUnityEditors` RPC accepts `{ hostId?, threadId? }` and returns `hostId`, `instances`, `warnings`, `claims` and `slots`. Supply a host or a thread whose environment selects one. This RPC always redacts claim IDs. Each slot includes its main Editors, MPPM clients and public ownership records.

## Upgrade from the separate Unity plugin

BB does not expose an SDK operation to transfer an environment's plugin owner.
Existing `unity-rampage-slot` environments owned by `unity` cannot be reused or
restored by `game-studio`, even though the provider ID is unchanged. Complete
this procedure **before updating the plugin source and disabling Unity**:

1. Finish work in the old environments. Release Editor claims and slot leases
   with the old Unity tools, and close Unity and its MPPM clients.
2. Archive their threads and delete the unused BB environments with
   `bb environment delete <environment_id>` while the old Unity plugin is still
   running. Wait for their status to become `destroyed`. The slot provider keeps
   checkout files and the Library cache (`ownsPath: false`).
3. Disable Unity, install or reload Game Studio, and run
   `bb game-studio slots list`. This imports the old claims, slot records,
   provisioning receipts, and completed legacy handoffs exactly once.
4. Re-register the preserved checkout paths with `bb game-studio slots register`.
   This reactivates slots retired by environment cleanup. Create new BB threads
   using the Rampage Unity slot provider; BB records Game Studio as their owner.

If you already updated with old provider environments present, restore the
previous Unity package version to complete steps 1–2, then upgrade again. Do not
edit BB's database or discard checkout files to change provider ownership.
Project Checkout environments retain their existing identity and need no
provider re-adoption; select their slot explicitly.

For installations that predate Unity, keep the updated Kitchen Sink running for
the read-only claims handoff. An existing `unity-editors` installation must also
expose its handoff RPC. Game Studio preserves completed migration receipts so
previously released claims are not imported again. Update automation to use
`game_studio_manage`, `game_studio_slots`, and `bb game-studio`.

## Use durable checkouts for parallel Unity work

[Popbot's durable slot design](https://github.com/proofofplay/popbot-tool/blob/main/docs/adr/0003-slot-as-durable-unit.md) keeps a checkout, its private Library cache, Editor and services together. Adopt that lifetime when preparing Unity environments: reuse a stable checkout and its cache across tasks. Keep each slot's services, ports, logs and test accounts separate. MPPM clients share a slot because they share Assets.

The `unity-rampage-slot` BB environment provider reserves persistent **Rampage client** checkouts. Create warm slots from a master checkout, or register an existing independent clone. Registration verifies the Rampage markers, Unity version, private Git metadata and isolated source/cache directories.

Register a stopped checkout against its Rampage BB project:

```sh
bb game-studio slots register --host host_id --project rampage_project_id \
  --path /absolute/path/to/rampage-client
bb game-studio slots list --host host_id
```

Create the pool once from that registered master. Run creation inside a BB thread, with Unity closed and the master checkout clean:

```sh
bb game-studio slots create --host host_id --source master_slot_id \
  --path /absolute/path/to/rampage-slot-1 --branch scott/slot-1
bb game-studio slots create --host host_id --source master_slot_id \
  --path /absolute/path/to/rampage-slot-2 --branch scott/slot-2
```

Each creation makes independent Git metadata and seeds `Library` using native copy-on-write. macOS uses APFS `clonefile` through Python 3; Linux requires native reflink support. Source and destination must support cloning on the same filesystem. Unsupported cloning fails; it never falls back to a full copy or hard links. Git LFS assets hydrate from the master's local objects without network fetches. Commit and hydrate the master before seeding.

The source lease is frozen during seeding, including against its owner. Unity must remain closed throughout. The clone excludes source GitButler state, Pipeline credentials, MPPM clones, Temp and Logs. Completed creation retries preserve the slot's changed files and cache. Failed creation leaves its partial directory and a fenced host receipt for inspection; recover the source lease explicitly and choose a new destination after a partial failure.

Select `unity-rampage-slot` when creating a BB thread. Empty inputs `{}` choose an available warm slot on that host and project. Allocation reserves it atomically before readiness checks; retries keep the same slot. Released slots keep their branch, work and Library for reuse. GitButler owns later branch changes; the slot manager never stashes or resets them.

Supply `{"slotId":"slot_id"}` to select a particular slot. Adopted Project Checkout environments require this explicit selection because BB retains their existing provider identity. New slots and environments already owned by Game Studio support automatic selection. An attached thread can use `bb game-studio slots acquire --slot slot_id`.

Keep both capabilities: the slot lease protects the checkout across tasks and Editor restarts; an Editor claim protects its exact process and native jobs. Leases survive idle turns, failures, archive/delete events and plugin reloads. They never expire automatically. BB's dispatch policy remains cooperative: explicit Send-now, edited-message resend and manual compaction bypass admission hooks. Direct filesystem access and physical input cannot be intercepted; managed Editor claims still enforce slot ownership.

For handoff, finish native jobs, release every Editor claim, and close the main Editor and its MPPM clients. Preserve dirty scenes before closing. Then release the slot:

```sh
bb game-studio slots release --slot slot_id --lease lease_id
```

Release preserves the checkout, Library cache, dirty files and GitButler state. Any failed or interrupted readiness check quarantines the slot. Close remaining Editors and verify completion, then use `bb game-studio slots recover --slot slot_id --confirm --note 'Observed completion evidence'`. Another caller can recover ownership only after its owning thread is archived or deleted. An unverifiable Unity process or a remaining Unity lock blocks handoff; the plugin never kills processes or removes locks.

Use `bb game-studio slots retire --slot slot_id` to retire an available slot. Provider removal performs the same checks. Retirement preserves all checkout files and prevents further leases until explicit registration. The provider uses `retireGraceMs: null` and `ownsPath: false`, so BB keeps warm environments and does not run destructive checkout teardown. Editor launch and Jetstream services remain outside this lifecycle.

If you explicitly deleted its BB environment, re-register the slot and restore an existing owning thread's environment before starting another task. Registration does not revive a destroyed BB environment record.

Keep GitButler for source control. Its [parallel-agent documentation](https://docs.gitbutler.com/ai-agents/parallel-agents) explicitly distinguishes shared branches from worktrees with isolated runtimes:

| Arrangement                      | Unity isolation                                    | Recommendation                    |
| -------------------------------- | -------------------------------------------------- | --------------------------------- |
| Applied branches in one checkout | Shared Assets, Library and Editor                  | One authoring owner               |
| Independent clones               | Separate checkout and local Git metadata           | Use for parallel authoring today  |
| Linked Git worktrees             | Separate checkout and Library, shared Git metadata | Pilot GitButler integration first |

The inspected `but 0.22.3` exposes experimental worktree management behind `worktreeManipulation`. Its linked-worktree commands and workflow differ from a normal GitButler workspace. This repository's GitButler plugin also discovers cross-machine workspaces through `gitbutler/workspace` and queues writes by checkout path, rather than Git common directory.

Independent clones fit that existing routing. Initialize GitButler separately in each clone instead of copying initialized `.git/gitbutler` state. This recommendation follows GitButler's [project identity](https://github.com/gitbutlerapp/gitbutler/blob/release/0.22.3/crates/gitbutler-project/src/project.rs#L172-L180) and [storage implementation](https://github.com/gitbutlerapp/gitbutler/blob/release/0.22.3/crates/gitbutler-project/src/project.rs#L259-L268). No multi-checkout GitButler mutation workflow was exercised during extraction.
