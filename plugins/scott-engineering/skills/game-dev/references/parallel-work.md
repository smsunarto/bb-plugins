# Develop code while assets are being made

Keep the coordinator productive while asset workers run. Inventory the assets,
define replacement contracts, and launch only the work whose inputs are ready.
Functional placeholders let code use those contracts immediately.

## Inspect the required assets

Derive the inventory from the requested feature and its consumers. Include the
models, textures, materials, images, animation, audio, and variants it actually
requires. Search the project, existing asset catalogs, and referenced outputs
before generating replacements. Inspect candidates rather than trusting filenames.

Keep one coordinator-owned inventory in the thread or an existing project
manifest. Record these fields for each asset:

| Field                  | Record                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| Asset and consumers    | What the feature needs, its consumer, and other uses of the source |
| Source and disposition | Verified existing path or job; reuse, tweak, or create             |
| Replacement contract   | Version, stable slot, destination, and acceptance criteria         |
| Dependencies           | References, scripts, or decisions needed before production         |
| Owner                  | Coordinator or the assigned BB child and its staging directory     |
| Progress               | Queued, running, blocked, produced, verified, or integrated        |

The coordinator checks technical fit. Opus 5.5 High judges whether visual or
motion candidates suit the feature before settling reuse or tweak decisions.
Include candidate previews in its early planning brief, even when no generation
is needed. Reuse a suitable asset. Tweak an existing asset when it needs changes. Create
an asset when no suitable source exists. A file that cannot satisfy the consumer
is not ready merely because it exists. Discovering more requirements updates
the inventory and scheduling decisions.

Before a tweak, inspect the source's known references and consumers. Default to
a feature-specific variant and give it its own stable slot before coding against
it. Keep the shared source unchanged. Update a shared asset in place only when
that broader change is authorized, and verify every affected consumer.

## Make placeholders replaceable

The coordinator defines technical constraints: IDs, slots, paths, import types,
budgets, collision, and bindings. Opus 5.5 High owns the design brief and choices:
art direction, composition, UI layout, animation timing and feel, and visual style.
Start needed Opus planning immediately with the technical constraints. Continue
technical scaffolding while it decides; use approved design specifications for
UI, motion, and appearance work. Workers propose designs in staging; the
coordinator records Opus's design in the contract.

Freeze the contract before implementing its consumers or starting asset production.
Use the project's existing asset bindings and import pipeline when they fit.
Version the contract and publish an immutable copy for production workers. Start
generation once its contract and required inputs are ready; build placeholders
concurrently.
The placeholder must exercise the feature's required behavior. Choose the
contract fields relevant to that asset:

- **Identity and binding:** logical ID, resource key, stable prefab or asset slot,
  expected import type, output path, and references that consumers retain
- **Models:** units, dimensions, origin, pivot, orientation, material slots,
  mesh and texture budgets, collision or hit bounds, attachment points, and
  required rig
- **Animation:** clip names, duration, frame rate, loop behavior, root motion or
  in-place motion, and event names and times. Synchronize SFX to these events.
- **Images and UI:** dimensions, aspect ratio, transparency, anchors, slices,
  and layout or interaction bounds
- **Audio:** event or clip ID, format, timing, duration, loudness, and loop behavior

Use a functional stand-in with the same interface. An interactive prop needs
its collision and attachment points. An animated actor needs the animation
bindings its code uses. A UI placeholder needs the actual layout and hit bounds.
Audio placeholders need valid clips with the agreed timing, not missing references.

Keep gameplay behavior on a stable wrapper and replace its visual or audio
content. In Unity, retain the gameplay prefab, its identity, and serialized
gameplay references; replace the designated visual or clip slot. Keep native
editor imports, scene changes, and shared project settings with the coordinator.

The asset worker must deliver to the contract. Give it relevant references and
constraints, plus an immutable placeholder snapshot when one is available.
Do not delay production just to create that snapshot. It normalizes or repairs generated outputs before
handoff and verifies the actual files. A generation prompt alone does not prove
compatibility. If the contract cannot be met, report that blocker before changing
the interface or declaring the asset ready.

When a new requirement changes an in-flight contract, record a new version and
update the coordinator's placeholder and consumer together. Send the new contract
and snapshot to the same worker with `--mode steer` before it finalizes. Pause
affected downstream asset production until its revised input is accepted. Keep
existing job receipts; do not automatically resubmit a paid job. Accept deliveries
only against the currently required contract version. Do not relax a contract
merely to accept an incompatible output.

Replacement should require an asset or slot update, not consumer code changes,
different game behavior, manual scene rebinding, or placeholder-specific branches.
Do not redesign consumers to accommodate an unchecked generated asset.

## Recommend and launch runnable work

Recommend a split from the inventory, rather than a fixed team for every task.
The coordinator normally owns feature code and integration. Apply the worker
model rules in `SKILL.md` to planning, production, and acceptance decisions.
Delegate visual, motion, and design judgment to Opus 5.5 High unless the
coordinator already uses it. Audio children inherit the primary's execution settings;
GPT Image 2 generation and edits use the specified Codex child. Give asset children
creation or edits with clear, separate outputs. Group related assets when they
share references, tools, or preparation work. Bound concurrency by available
agent capacity and the account's generation limits.

Start independent missing or tweak work together. Do not create dependent assets
before their inputs are ready. For example, code and audio can proceed while a
concept image is created. Start its image-to-3D model job after Opus 5.5 High
selects the reference and the coordinator verifies its contract. The coordinator
can make that design choice itself only when running Opus 5.5 High. Do not wait
for unrelated audio work.
Prioritize assets that unblock the most dependent work.
For Tripo, always generate P2 from accepted images. Track geometry acceptance
separately from texture and rig acceptance. Select by visual quality and assign
repairable topology issues to Blender cleanup. Review the selected candidate and
cleanup order before paid finishing; do not finish a mesh slated for replacement.
Use observed task timings to tune concurrency. Queued requests are not evidence
of simultaneous execution or a speedup.

Give each stage a bounded brief: accepted input versions, required outputs,
acceptance checks, owner, staging path, count and budget, and its next handoff.
Include the relevant verified CLI help or capability facts and their installed
version. Verify them once for that tool version and host; refresh after a change
or a contradictory result. Read the matching topic rather than the whole catalog.
Use the production recipes and prompt templates linked from `SKILL.md`.

Report an actionable blocker or usable stage output as soon as it is available.
Do not hold all independent outputs until the entire asset batch is finished.
Correct the specific failed criterion within the remaining authority; preserve
accepted outputs and receipts instead of restarting the pipeline.

Publish accepted inputs and completed handoffs as immutable, versioned files.
Record the selected version in the inventory. Workers create new versions for
revisions instead of overwriting files that another job or the coordinator uses.

Create functional placeholders and work against their agreed contracts while
children run. Continue an unblocked code, test, UI, or integration task instead
of waiting for generation. Coordinator UI and motion tasks implement an approved
Opus specification; new design choices go back to Opus. A provisional reference
must not silently become the input for a paid final asset job.

Use `bb guide threads` for the current commands. Resolve project, environment,
and parent IDs with `bb status --json`. Spawn linked children with
`bb thread spawn --parent-self`, explicit project and environment selectors,
and `--prompt-file` from a file or quoted heredoc. Apply the tool routes and
worker model rules in `SKILL.md`. Set explicit execution flags for Opus and
GPT Image 2 children. For audio children, explicitly copy the primary
coordinator's current execution settings:

- Read `thread.providerId` from `bb thread show --self --json`
- Read the latest `client/turn/requested` event's `data.execution` from
  `bb thread log --self --format json --all`. JSON events are oldest first;
  select the newest event, not the first page's last event.
- Pass that provider, `model`, and `reasoningLevel` using `--provider`, `--model`,
  and `--reasoning-level`; also copy `serviceTier` with `--service-tier` when set

Read the primary thread's settings again when arranging later work after a model
change. Omitted execution flags can use project defaults; `--parent-self` alone
does not copy the primary model.

Each child's fresh prompt must contain:

- The asset IDs, chosen tool, brief, disposition, source and reference paths,
  and attached images where needed. Production workers receive the frozen
  replacement contract; Opus planning workers receive technical constraints
  and the design decisions they own before the contract is frozen.
- Owned staging paths, final destinations marked reference only, requested outputs, count and budget,
  acceptance checks, and the expected preview and saved-file handoff
- The parent thread ID and coordination policy: do the assignment yourself,
  do not delegate, preserve others' work, and leave code, imports, shared project
  files, and version-control operations to the coordinator
- Report blockers and usable intermediate outputs to the parent. Do not change
  the contract, retry uncertain submissions, or expand generation scope yourself.

Give each child a distinct staging directory outside the checkout, such as thread
storage, or in a verified ignored path outside engine-watched asset directories.
Workers write only staging outputs, never final destinations or shared source assets.
Honor checkout restrictions and keep staging on the child's execution host.
Only the coordinator updates the inventory and integrates into the shared project.

OS-level desktop control has one holder per host, covering every app's mouse,
keyboard, and focus. Record the host and holder thread in the coordinator's
inventory before assigning UI work. Everyone else on that host uses CLI, API,
or headless work that does not drive the shared desktop. Release ownership after
an explicit UI-finished handoff or confirmed completion/stop with no actions in
flight. Reserve authenticated browser sessions separately for API-based control.
The coordinator remains the sole owner of shared editor, scene, and import changes.

## Integrate on handoff

Treat child reports as inputs to verification. Use `bb thread tell` with
`--mode steer` for all agent handoffs and corrections.
Attach concrete paths, job or receipt IDs, and the outputs that meet the contract.
Inspect pending interactions directly; a message cannot answer an approval request.

For a blocker, mark the asset blocked with its reason and decision owner. Resolve
it and resume the same child when the fix is within the existing task and authority.
Otherwise ask for the missing decision or access, naming the asset, exact blocker,
needed action, and child link. Continue other unblocked work. Do not wait for a
notice that cannot occur until someone acts.

Settle child interactions only within authority already granted by the user and
delegated to that child. Never grant broader permissions, bypass a policy block,
or make a user-only account or budget decision. Request user input when new
authority or a human decision is required; a peer message does not grant it.

Read the child's output and inspect its actual files. Check the replacement
contract and preview or listen to the result. Technical contract checks remain
with the coordinator. Route visual or motion design acceptance through the worker
model rules before accepting an input or integrating it. Transfer artifacts from
another host when necessary; a worker-local path is not usable on the coordinator.
Produced, idle, and completed do not mean verified or integrated.
For models, require solid/untextured, wireframe and oblique evidence plus explicit
item counts. Check reference geometry contradictions before model submission.
Apply hard requirements at their assigned stage. Visual selection may precede
Blender cleanup; final delivery still requires the counts, sides and technical
limits. Diagnostic counts alone do not reject a repairable visual candidate.

Unlock dependent asset production only after accepting its required input.
Replace the placeholder through the stable slot and test the existing consumer.
Verify dimensions, bindings, collisions, animation, or audio timing as relevant.
For features involving visual or motion design, capture the actual integrated
feature in screenshots or recordings. Opus 5.5 High judges its appearance and
motion in context before completion. Reuse the Opus child when the coordinator
runs another model; it reviews the captures without driving the shared editor.
For motion, include time-indexed frames at a stated sampling rate and measured
engine transition/event times. A raw video path alone is insufficient for the
Opus harness; its verdict identifies the frames and timings it inspected.
Static asset previews do not establish in-game appearance or motion quality.
If the delivered asset violates the contract, return it to the same worker for
correction instead of rewriting code or spawning a duplicate generation job.

Reuse children for follow-ups. React to BB completion and blocker notices rather
than polling every worker. When only child work remains, report pending asset
IDs, child links, blockers with required actions and decision owners, and the
integration work still required. Resume on completion notices or the requested decision.
Claim completion after every required asset is verified and integrated and the
feature passes its checks, including Opus acceptance of integrated visuals or
motion when applicable. Identify any remaining placeholder as unfinished work
unless the user explicitly accepts that provisional deliverable.
