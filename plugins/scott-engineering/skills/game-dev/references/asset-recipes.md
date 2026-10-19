# Asset production recipes

Choose the recipe that fits the deliverable. Use the model rules in `SKILL.md`
and the contracts, staging ownership, and coordination rules in `parallel-work.md`.
Start from suitable accepted assets; a recipe is not a requirement to regenerate them.
Use the corresponding stage briefs in [Prompt templates](asset-prompts.md).

## Character or creature to a game-ready 3D asset

Use this pipeline when a new character needs design exploration and consistent
references. The coordinator can build gameplay, stable slots, collision,
animation bindings, and tests while asset stages run. Audio and unrelated assets
can run independently; final audio synchronization uses the approved event timing.

Before paid production, use P2 Clean Topology and choose the rigging plan. Map a required rig
to a supported family, or assign an available external rigging workflow and owner.
Tripo offers biped rig specifications such as actorcore, mixamo, unreal, unity,
and vrm, plus its own preset motions. That does not establish compatibility with
an arbitrary existing skeleton or custom clips. If no compatible plan exists,
report the blocker before generating geometry. The coordinator owns engine
retargeting, existing clips, clip names and events; Opus owns motion design.

For multiview input, verify the selected engine's slot convention before paid
submission. The local docs list slots but do not define their anatomical meaning.
Wrapper image-task outputs contain indices and URLs, not slot labels. Their
download names and display order do not establish camera-to-slot meaning.
Use a prior multiview-to-model submission for the selected engine version, with a retained map of
exact slot filenames and character-frame camera positions covering the slots this
job uses, plus its model inspected for asymmetric feature placement. Wrapper task
records alone do not retain that map.
Alternatively, use Studio's explicitly labelled conversion inputs when available,
with the original front to identify anatomical sides; do not infer from grid order.
Record the evidence and tool/engine version, and include the verified mapping in
both image and model briefs. Retain the input map and inspected output with the
handoff so later work can reuse the evidence. If neither source establishes the
mapping, report the blocker before paid submission. A new paid probe needs existing
count/budget authority or a user decision; never guess or silently change routes.

| Stage              | Owner                             | Input                                                                  | Accepted handoff                                             |
| ------------------ | --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| Design exploration | Opus, using Midjourney            | Role, camera, style references, technical constraints                  | One selected concept and an identity specification           |
| Reference views    | Codex, using GPT Image 2          | Selected concept, approved hidden details, pose and view specification | Separate, matching view images with an orientation map       |
| Model production   | Opus, using Tripo P2              | Accepted view files and frozen replacement contract                    | Visual candidate and cleanup plan, then authorized finishing |
| Integration        | Coordinator, with Opus acceptance | Verified bundle and stable placeholder                                 | Working feature and accepted in-game captures                |

### Explore and select the design

Give Opus the character's role, silhouette at the gameplay camera, existing style
references, scale, equipment, and rig requirements. It owns the Midjourney prompt
and candidate choice. Bound exploration by the authorized count and budget.
Use Fast generation unless a different speed was explicitly requested.
Ordinary Midjourney 8.2 batches contain four outputs; `--draft` defaults to 24.
Do not use draft or repeat as an implicit expansion of the requested output count.

Select a full-body concept that exposes the shapes needed for modeling. Opus
records the accepted proportions, anatomy, palette, materials, and asymmetric
details. It also decides unseen back and side details before view generation.
An attractive front image does not define the character's back or hidden equipment.
Distinguish style exploration from reconstruction acceptance. A selected concept
with wrong sides or pose can guide style, but cannot be an accepted geometry input.
The canonical front must correct those hard failures before any model job.
Record exact counts, anatomical sides, attachment surfaces and depth for equipment.
For each camera, state which features should be visible, hidden, or edge-on.
Save the selected concept and specification as immutable versions. If an existing
concept already satisfies this brief, reuse it and skip paid exploration.

### Prepare a consistent view set

Send the accepted concept and design specification to the Codex image child.
Request one image file per required view, rather than a collage as the model input.
Specify the neutral pose, camera orientation, framing, background, and common scale.
Follow [Tripo's reference guidance](https://www.tripo3d.ai/help/features/how-to-get-better-image-to-3d-results):
a centered subject occupying about 70–85% of the frame, clean margins, a plain
white or light-gray backdrop, diffused light, and at least 1024 px where possible.
Use matte reference rendering, complete feet, separated limbs, and an A/T-pose
for characters. Remove scenery, labels, extra subjects, glare and strong shadows.
These are input recommendations; contract-specific tolerances remain explicit.
Choose the pose to expose required geometry from the selected camera. For a
front reference with separate fingers, palms toward the thighs hide the gaps;
palms facing the camera with slightly fanned fingers can expose them. Check the
projected width-to-height ratio against the chosen canvas, occupancy and margins
before generation. A wide pose can fit a square canvas without changing anatomy.
Version a presentation amendment when needed; do not waive acceptance checks.

Prepare and accept a canonical front first, reusing an already suitable front when
possible. Every other view uses that front and the same identity specification.
Do not attach the earlier concept again if its pose, proportions or equipment
conflict with the accepted front. Resolve any front/specification contradiction
before generating dependent views; record deviations explicitly. Opus checks identity and cross-view consistency before
the coordinator unlocks model generation. Left and right definitions must be
explicit in the view specification; verify the actual camera orientation before
naming a file. Never create a side view by mirroring an asymmetric character.

Keep one Codex worker responsible for the matched set. Independent view requests
may be dispatched together when supported; they all reference the accepted front.
Dispatch times do not prove concurrent generation. Our eval finished views one
at a time, so do not promise a speedup. Prepare briefs and checks while jobs run. Do not spawn an uncoordinated worker for every angle.
Return each usable view promptly. Compare silhouettes, limb lengths, equipment
placement, and hidden details together; a prompt asking for consistency is not proof.
Correct only failed views within the remaining budget, keeping accepted versions.
Reject references that cannot depict one physical object, even with a good style
score. Check surface direction, equipment counts, attachment depth, scale, sole
line and shared landmarks. Front/back images alone cannot verify depth.
Do not force naturally hidden equipment to appear in every view. A lens on one
outer side face should be face-on in that side view and edge-on elsewhere.
[Tripo's multiview guidance](https://www.tripo3d.ai/blog/multi-view-reference-images)
requires consistent object state and capture; extra contradictory views add risk.

Our Tripo wrapper accepts 2–4 individual view files. A front and at least one other
view are required. Filenames assign `front`, `left`, `back`, and `right` slots;
unassigned filenames fall back to that order. Use filenames exactly `front.png`,
`left.png`, `back.png` and `right.png` in a versioned asset directory, selecting
only the required ones. The parser matches orientation words anywhere in a
filename; prefixes such as `backpack-scout-left.png` can assign the wrong slot.
Keep asset IDs in directory names, not view basenames. Record each file's actual
camera position in the character's own frame separately from its Tripo slot.
Use "character's left/right" for anatomy and equipment, never "image left/right".
Four views are useful when the character needs coverage on every side, but request
only the set justified and authorized for this asset. Do not feed a contact sheet
or an entire multi-output image task directly to `multiview-to-model`.

### Generate and prepare the model

The Tripo worker reads the wrapper's current embedded skill and parameter topic.
Use the accepted files with `generate multiview-to-model`. This example assumes
four accepted views and a populated triangle budget from the contract:

```sh
"$HOME/.local/share/cli-overrides/bin/tripo" generate multiview-to-model \
  "$asset_staging/views-v1/front.png" "$asset_staging/views-v1/left.png" \
  "$asset_staging/views-v1/back.png" "$asset_staging/views-v1/right.png" \
  --model tripo-p2 --param symmetry=false \
  --param face_limit="$asset_triangle_budget" \
  --json --no-open -o "$asset_staging/model-v1"
```

Always use P2; H-series, P1 and text-to-model generation are blocked by the wrapper.
An approved single image can use `image-to-model` without extra view jobs.
P2 produces geometry only in our Studio adapter. Set the contract's face budget
and symmetry deliberately; keep symmetry false for asymmetric equipment.
Do not chain paid finishing onto an unreviewed mesh. Opus selects the visual
candidate and reviews its Blender cleanup plan first, then run only separately
authorized cleanup, texture, rig or export stages in an order that preserves work.
A processing version such as texture v3.0 is not an H-series geometry fallback.

Read `tripo docs --topic quality`. Inspect solid, untextured and wireframe renders
from cardinal and oblique cameras before spending on texture. Count each required
item on views that expose it; color area on the correct side does not prove count.
Surface the oblique evidence in the handoff. Check fused limbs, intersections,
stray components, degenerate faces, density and joint loops as the contract requires.
P2 or a low face count alone does not prove clean topology or deformation quality.
For a quad contract, inspect a quad-preserving export before GLB triangulation.
A required inspection export may precede mesh acceptance within its explicit
budget; final delivery exports follow finishing. If quads cannot be retained,
report the blocker rather than claiming a triangulated GLB proves quad topology.
Consider a separate procedural attachment for simple cylinders, buckles or lenses
when the approved contract allows it; a named socket guarantees placement and count.
Inspect and normalize the actual bundle in staging: scale, axes, pivot, triangle
count, materials, textures, attachment points, and the assigned rig family.
After model generation, check actual rig suitability before paid rigging. Use
documented rig operations and only the preset motions assigned to Tripo. A free
rig check needs a completed model; preflight does not guarantee the mesh is riggable.
Skip rig work for static assets. Keep custom clips and event timing with the
coordinator's engine workflow, or their explicitly assigned external owner.
Do not use the unsupported `--for anim` default chain as a shortcut.
Keep source task IDs and receipts; resume known tasks rather than duplicate them.

### Search for a good candidate

Generation is stochastic; do not expect the first result to be perfect. Within
the authorized count and budget, prefer small candidate batches before lengthy
manual repair. Submit independent candidates asynchronously when supported,
retain each receipt, and inspect outputs at the same camera and display scale.
Before fan-out, confirm the charge for the first paid job of that operation kind
as described in `tripo docs --topic parameters`. Read that topic before choosing
Tripo's native `-n`/`variations` candidates or independent submissions. Native
candidates share one request; the group retains each candidate's receipt,
including rejected candidates. Inspect the group with `tripo model candidates`
and keep its partial-success status. Billing must fit the budget.
Rank candidates with Opus primarily by silhouette, identity, proportions, surface
appearance and readability at gameplay scale. Keep repairable topology issues
as Blender cleanup tasks rather than rejecting a strong visual candidate solely
on diagnostic counts. Apply final counts, sides and technical limits after the
assigned cleanup; visual selection is not final-delivery acceptance.

For a quality experiment, record the hypothesis and vary one factor at a time,
or label the run as fresh sampling with identical settings. Freeze input hashes,
comparison captures and measurement methods. If several factors change together,
report a workflow improvement without attributing it to one model or setting.
Set a batch limit and stopping criterion before running; a new deliberate
candidate is distinct from retrying an uncertain submission. This adapts
[fal's variation and fan-out patterns](https://github.com/fal-ai-community/skills/blob/main/skills/genmedia-workflow/references/pipeline-patterns.md).

### Integrate and accept the character

The coordinator verifies the complete handoff, replaces the placeholder's visual
slot, and tests the existing gameplay. Retain the gameplay prefab identity and its
references. Exercise collisions, sockets, clip bindings, root motion, and events.
Retarget existing clips and configure their events without changing gameplay
interfaces. Capture the character at the actual gameplay camera and in motion.
For Opus, provide the recording plus timestamped frames at a stated sampling rate
and measured engine clip, transition and event times. Use `ffmpeg` or the existing
capture tools to extract the frames; include enough samples around transitions
and interruptions to judge them. A video file alone is not a readable review input.
Opus judges silhouette, lighting, materials, deformation, and motion feel in context.
Its verdict cites inspected frames/timestamps and any coverage gaps. Return model
or rig defects to their asset owner; clip binding, retarget and event defects go
to the coordinator, with motion-design decisions going to Opus. Preserve the
contract instead of changing consumer code to accommodate an incompatible asset.

For props, reuse the same concept and view stages when needed, but omit character
anatomy and rig work. Specify placement, pivot, collision, sockets, and material
slots. An approved single reference may use `image-to-model` without extra view jobs.

## 2D illustration, sprites, and UI art

Opus first establishes the composition and visual language using existing art or
Midjourney exploration. GPT Image 2 handles exact edits, reference fidelity, and
prescribed variants. Preserve approved identity and composition across outputs.
Specify dimensions, alpha, anchors, slices, atlas rules, and interaction bounds
before production. Generate only the requested variants, keeping separate outputs.

The coordinator implements the stable layout and bindings while art runs. Inspect
the exported files, then replace the designated slots. Opus reviews the integrated
result at the intended display scale, including hover, pressed, disabled, or other
required states. Reuse an existing editable vector asset when that is the proper
source; do not replace deterministic UI geometry with generated raster art.

For frame-based animation, define the action, facing, frame count, strip or grid
layout, timing, and contact anchor before generation. Prefer producing a matched
strip together when the tool supports it. Normalize frames to a common canvas,
subject scale, and anchor. Check identity, palette, clipping, alpha, and foot or
contact-point drift across frames. Play idle/action transitions at gameplay scale
to detect jumps, and verify that animation keys and event timing match the consumer.

## UI, animation, and motion graphics

Opus defines the relevant states, hierarchy, key poses, timing, easing, interruption
behavior, and reduced-motion behavior when applicable. Use the motion brief template
to produce an implementable specification. The coordinator builds those approved
states and timings against functional placeholders while art is produced.

For a heads-up display (HUD), use
[Scene direction's HUD guidance](scene-direction.md#keep-the-playfield-readable)
to define persistent information, contextual surfaces, and overlay input behavior.

Audio workers use the primary model and approved event times. Generate SFX with
ElevenLabs and music with Suno; do not wait for final character geometry when
the scene mood or event specification is already settled. After integration, the
coordinator captures transitions, loops, and interruptions and supplies timestamped
frame sequences and measured transition/event timing alongside the recording.
Opus judges that evidence and cites its inspected frames/times; isolated still
frames cannot establish motion timing or feel.
