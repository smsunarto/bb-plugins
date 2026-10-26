---
name: assemble-unity-scene
description: Assemble or revise a 3D Unity scene to match a Game Studio render target, tracking every object's acceptance criteria and visual evidence in a living SCENE.md.
---

# Assemble a Unity scene

Deliver the requested scene with its composition, objects, camera, motion, and
atmosphere checked against the selected target. Own the correction loop: identify
visible defects, repair them, and inspect fresh captures before handoff. A valid
mesh, completed generation, or successful import cannot establish visual quality.

Use this workflow for scene assembly and focused scene revisions. Keep a
design-only request at planning scope; an asset-only request uses the relevant
asset checks without claiming that a scene was verified.

## Establish the target and project

1. Read `game_studio_canvas_context` and the existing `game-studio` skill. Resolve
   the owning game, checkout host, board, target node, chosen take/asset, and exact
   reference image. Follow pagination and read relevant design documents. Open
   the actual target at full resolution; preserve a stable reference path and
   identity so a later take cannot silently change the brief.
2. Inspect the Unity version, render pipeline, target platforms, quality tiers,
   representative scenes/materials, and existing camera/render settings. Record
   the actual ZLZ Character and Environment shader asset names and material
   references; these are project-specific, not Unity built-ins. If unavailable,
   record the blocker and continue independent planning; do not substitute a
   different shader and claim compliance.
3. Follow `unity-editors` for leases and exact Editor claims and `unity:unity-cli`
   for Editor operations. Reserve before opening; verify project path/PID and
   quiet state before writes. Route file work to the checkout host, and resolve
   staged media through the returned `mediaDir`. Preserve unrelated scene work.
4. Create or update a literal `SCENE.md` using [the template](assets/SCENE.md).
   Reuse the scene's existing file; otherwise use a scene-specific directory in
   the project's design area, such as `canvas/scenes/<scene-id>/SCENE.md`. Link
   it from the existing Game Studio design document using its revision-aware
   update flow. A document titled SCENE.md still receives a UUID filename in
   Game Studio; it is not a substitute for this file. Keep one authoritative
   acceptance ledger, and reread/merge concurrent edits.

Proceed when the reference, scene scope, project baseline, and acceptance ledger
are identified. A single image rarely determines hidden geometry or absolute
dimensions: distinguish observed requirements, user decisions, and assumptions.
Resolve consequential ambiguity with the user while continuing independent work.

Before a focused revision, record the accepted baseline and its revision in
`SCENE.md`, the properties the request allows to change, and the accepted
properties and relationships to preserve. Preserve other accepted properties;
record scope inferences in the decisions ledger. Assign stable references by
property: a shading or mood reference need not govern geometry or layout.
A shader-look edit retains the accepted geometry and layout. When the request
redistributes lights while preserving floor dimensions, positions and row
alignment may change. An explicit redesign updates the preservation scope.
Before editing, reuse matching baseline evidence or capture missing required
views/states at comparable camera, resolution, quality, and animation time.
Record their evidence IDs. Compare protected relationships after the edit,
including side gaps, overlaps, and background visibility from each required view.
Keep unestablished dimensions and hidden geometry in the assumptions ledger.

## Keep SCENE.md live

Break the target into foreground, midground, background, focal subjects,
architecture, supports, dressing, and effects. Account for every visible element
and any unseen support required for physical plausibility. Give each object a
stable ID mapped to its prefab/scene hierarchy and canvas provenance. Repeated
instances may share an asset contract, but every placement needs its own identity
and contact/visibility result.

For each object record silhouette, construction, real dimensions, pose,
position/orientation, relationships and contact surfaces, material/texture,
emission, animation, and intended camera visibility. Specify measurable framing
landmarks or tolerances where useful; also name the visual read that numbers
cannot establish. Cover camera and environment with their own criteria IDs.

Each criterion has a requirement, source, verification view/time, status, evidence,
and next correction. Use `pending`, `pass`, `fail`, `blocked`, or `not-applicable`.
Only checks actually performed on the current integrated result can pass; give
not-applicable checks a reason. Track explicit user-approved deviations separately
without relabeling a failed requirement as passed.

Update the ledger after each candidate selection, import, layout pass, visual
review, and correction. New requirements extend it; they do not erase old ones.
Changing a mesh, material, pose, transform, camera, lighting, effect, quality tier,
or target invalidates all dependent passes. Mark them pending and recapture.
Keep useful failure history and the latest evidence, with artifact paths and the
scene/asset revision or hash, camera, resolution, quality, and animation time.

Protect cited media from cleanup: a standalone `SCENE.md` is outside Game Studio's
retention scan, and linking to it does not retain its references transitively.
Keep cited takes picked/starred, or name each staged asset's actual ID/path in a
registered Game Studio document or board. A catalog entry alone is insufficient.
Record this retention location in the ledger, including targets and UV candidates.
`canvas/evidence/` is checkout-local and ignored by Git. For portable handoffs use
the project's tracked/LFS or durable artifact storage for final evidence; otherwise
record its owning host, path, hash, and retrieval limitation explicitly. Verify
the retained files remain readable before handoff.

## Produce the assets

Read [asset production](references/asset-production.md) before generating or
accepting models. Its gates cover projected detail budgets, metric scale,
Tripo provenance, Smart UV application, texture reuse, PBR, and mesh inspection.

All new or replacement visible scene geometry must originate in Tripo, including
ground, architecture, and props. Reuse compatible Tripo assets with verifiable
provenance. Do not hand-model, script a replacement mesh, or use visible Unity
primitives as a shortcut. Non-rendered layout guides, empty transforms, cameras,
lights, colliders, and effect components are scene infrastructure. Engine-native
particle billboards are allowed; authored mesh assets used by effects, such as
water surfaces or mesh particles, must originate in Tripo. Preserve out-of-scope
existing content and record it rather than silently rebuilding the project.

Use the native Game Studio generation tools within the authorized paid scope.
Retain request IDs across retries, collect jobs to terminal status, and reconcile
uncertain dispatches before another submission. Keep paid retries at zero unless
authorized. If the budget or a required service blocks a fix, leave the affected
criterion blocked and finish independent work; never pass an uninspected asset.

## Import accepted assets into Unity

Inspect each selected staged file's actual bytes under `mediaDir` and its receipt;
the receipt does not verify modified bytes. Under the main Editor's authoring
claim, import into the project's established `Assets/` structure and configure
the actual importer, metric scale, pivot, and materials. Preserve prefab GUIDs,
`.meta` files, serialized references, material slots, rigs, animation events, and
gameplay bindings when replacing content. Validate the imported derivative in
its consumer scene/prefab before updating canvas/catalog entries with its
Assets-relative path. Keep retained staging sources and receipts linked to that
derivative. Apply the same import checks to coarse layout assets and final assets.

## Lay out the entire scene

1. Establish a metric layout, ground datum, and camera from the target's horizon,
   perspective, focal landmarks, and foreground/background overlap. Place all
   required Tripo objects, including supports and background masses, before
   polishing individual props. Early generated geometry can establish layout;
   finishing is required before final acceptance. Track every temporary asset.
2. Match position, rotation, spacing, pose, and depth at real dimensions. Use the
   camera's position and projection to establish apparent size; do not stretch
   models or shrink a distant building to fake perspective. Fix framing before
   refining textures. Record any intentional stylization as part of the brief.
3. Capture the whole scene from the target camera and inspect side by side with
   the reference. Check all inventory IDs, missing masses, silhouette, negative
   space, focal hierarchy, and relative scale. Inspect oblique/side views for
   grounding, believable support, unwanted intersections, floating objects,
   z-fighting, and geometry hidden by the target view.
4. Use [Unity visual checks](references/unity-visual-checks.md) for camera,
   clipping, bounds, LOD, and occlusion. Required geometry must remain visible
   throughout the supported view/motion range; intentional target crops and
   occlusions are recorded, not mistaken for culling failures.

Advance to finishing only after every required object is placed and the layout
review has no unexplained omissions or physical placement defects.

## Finish motion, lighting, and atmosphere

Apply the project's verified ZLZ Character/Environment material conventions.
Match light direction, shadow shape/softness, warm/cool balance, contrast, focal
hierarchy, and mood. Preserve dark areas when the target calls for them. Tune
exposure/tonemapping and bloom with the actual camera and quality tier; isolate
intentional scene overrides rather than changing shared project settings casually.

Complete the motion and rendering sections of
[Unity visual checks](references/unity-visual-checks.md). Inspect animation in
real-time playback and at contact/extreme poses, including transitions and loop
seams. Check that bodies, clothes, props, and particles respect their intended
contacts and that rigs do not collapse, twist unnaturally, or ghost through other
objects. Inspect fog, haze, liquid, reflections, emissive details, and particles
in motion. A still frame cannot pass animation or flicker checks.

## Verify, correct, and hand off

Run a review of the complete scene, then inspect every object against its ledger.
Use actual Unity Game-view/runtime captures at target output size and supported
camera states. Inspect the pixels yourself; programmatic bounds, mesh, collision,
and performance checks supplement this review. Review a representative motion
recording at normal speed and slow/frame-step trouble spots. Use the project's
available visual reviewer workflow for an independent final pass when supported.

Fix failures in dependency order: missing/incorrect assets and layout, camera,
materials/lighting, animation/effects, then optimization. Recheck the complete
composition and affected criteria after each fix. Profile the final scene on
the target hardware/quality where available; an Editor result alone cannot pass
a device budget. Preserve untested platforms as unverified.

The ready gate requires every in-scope criterion without an approved deviation
to pass or have a justified not-applicable result. A user-approved deviation may
waive a named gate; retain its actual status and evidence, link the approval, and
label the outcome **ready with approved deviations**, never fully conforming.
Otherwise, missing objects, temporary assets, stale evidence, or unverified
required views prevent readiness. If a gate remains blocked, hand off an
explicitly incomplete result with the exact blocker and remaining criteria.
Do not ask the human to rediscover defects already visible in the evidence, or
weaken criteria to make the checklist green.

Save the scene/prefabs and `SCENE.md`, settle owned Editor work and pending jobs,
and follow `unity-editors` for release. Hand off links to the target, current
scene, ledger, matching render comparison, motion evidence, and relevant
performance results. State deviations, remaining limits, and commit status.
Distinguish agent-verified conformance from human art approval.
