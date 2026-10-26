# Scene acceptance: <scene name>

## Target and scope

- Game / checkout host / root:
- Unity scene path / scene ID / current revision or artifact hash:
- Game Studio board / target node / chosen take / asset ID:
- Stable target image path or link / content hash / reference date:
- Target image: ![Render target](reference-path)
- Existing design document link:
- Requested result / in-scope objects / preserved surrounding content:
- Unity version / render pipeline and version / color space:
- Target platforms / hardware / resolution / aspect ratios / quality tiers:
- Current stage / last review / reviewer:
- Outcome: incomplete / ready / ready with approved deviations.

## Focused revision baseline

For revisions to an accepted result; otherwise mark not-applicable.

- Accepted baseline scene/capture / revision or hash / evidence IDs for required views/states:
- Requested revision / affected IDs / allowed property changes:
- Preserved properties and relationships / comparison criteria IDs (including protected gaps, overlaps, background visibility):
- Governing references: property (geometry/layout, materials/shading, lighting/mood) → path/link / content hash / retention location:
- Preservation requirements superseded by an explicit redesign / source of that decision:

## Observations, assumptions, and decisions

| ID   | Source or target region | Observed requirement or assumption | Decision / unresolved question |
| ---- | ----------------------- | ---------------------------------- | ------------------------------ |
| D-01 |                         |                                    |                                |

## Camera and composition

- Camera object / projection / position (m) / rotation (degrees):
- FOV or orthographic size; physical sensor / focal length / lens shift / Gate Fit when used:
- Near/far clip / culling mask / render scale / output dimensions:
- Camera path, allowed views, capture time/pose, and intentional crops/occlusions:
- Horizon, focal landmarks, screen-space extents, negative space, overlap/depth:
- Criteria IDs:

## Scene inventory

One row per placed instance or uniquely enumerated repeated instance. Asset
contracts may be shared; placement and visibility results remain traceable.

| Object ID | Target region / role | Tripo source / asset contract | Prefab / hierarchy path | Dimensions W/H/D (m) | Position / rotation / parent | Contact/support / neighbors | Criteria IDs |
| --------- | -------------------- | ----------------------------- | ----------------------- | -------------------- | ---------------------------- | --------------------------- | ------------ |
| OBJ-01    |                      |                               |                         |                      |                              |                             |              |

### Asset contract: <asset ID>

- Instances / silhouette / construction / recognizable details:
- Real dimensions and reference / measured Unity world bounds / import conversion:
- Intended screen size / nearest camera / motion range / detail rationale:
- Triangle budget and actual / LODs / vertices / submeshes / material count:
- Surface, palette, texture scale, wear, roughness/metallic, emission regions:
- Tripo generation / Smart UV candidate / chosen take / Apply UV / texture / PBR jobs:
- Final generated asset path/hash / imported derivative / material paths:
- Rig / animation clips / pose / contacts / root motion / deformation requirements:
- Solid and wireframe / UV / material inspection evidence:
- Temporary replacement or missing finishing stages:
- Criteria IDs:

## Shared materials and textures

| ID / Unity path | Using objects | ZLZ shader / reference material | Maps / packing / color-space settings | UV compatibility / texel density | Resolution / mips / compression / platform | Emission mask / intensity | Memory or build cost |
| --------------- | ------------- | ------------------------------- | ------------------------------------- | -------------------------------- | ------------------------------------------ | ------------------------- | -------------------- |
| MAT-01          |               |                                 |                                       |                                  |                                            |                           |                      |

## Environment, lighting, and motion

- ZLZ Character / Environment shader paths and baseline material references:
- Lighting direction / key, fill, rim / color balance / contrast / mood:
- Realtime, baked, mixed lights / shadow quality / lightmaps / probes / reflections:
- Volume/profile / exposure / tonemapping / grading / bloom / AA / other overrides:
- Fog/haze / sky / liquid / particles / weather: density, depth, bounds, motion, intersections:
- Emission regions / visible glow / required light spill:
- Clips and transitions / full cycle duration / contact phases / camera and object paths:
- Intentional flicker or nonphysical effects and their approved source:
- Criteria IDs:

## Acceptance ledger

Status: pending, pass, fail, blocked, or not-applicable (with reason).
Each row covers one check, with explicit view/time/quality conditions and current
evidence. Replace the seed rows and extend them for every object and requirement.

| Criterion ID     | Object / scope                | Requirement and source | Pass condition / tolerance | View / time / quality / method | Status  | Evidence ID / observation | Next correction or N/A reason |
| ---------------- | ----------------------------- | ---------------------- | -------------------------- | ------------------------------ | ------- | ------------------------- | ----------------------------- |
| OBJ-01.shape     | OBJ-01                        |                        |                            |                                | pending |                           |                               |
| OBJ-01.scale     | OBJ-01                        | 1 unit = 1 meter       |                            |                                | pending |                           |                               |
| OBJ-01.surface   | OBJ-01                        |                        |                            |                                | pending |                           |                               |
| OBJ-01.placement | OBJ-01                        |                        |                            |                                | pending |                           |                               |
| OBJ-01.motion    | OBJ-01                        |                        |                            |                                | pending |                           |                               |
| CAM-01           | Camera/composition            |                        |                            |                                | pending |                           |                               |
| ENV-01           | Lighting/mood/emission        |                        |                            |                                | pending |                           |                               |
| FX-01            | Atmosphere/temporal stability |                        |                            |                                | pending |                           |                               |
| PERF-01          | Target platform budget        |                        |                            |                                | pending |                           |                               |

## Evidence and review history

- Staged artifact retention: picked/starred takes or exact asset IDs/paths named in a registered document/board:
- Final target/capture/receipt storage: durable or tracked location; otherwise checkout-local host, path, hash, and retrieval limit:

| Evidence ID / date | Scene + asset revision/hash | Camera / resolution / quality / platform | Pose / time range / seed | Capture or report link | Checks performed / result |
| ------------------ | --------------------------- | ---------------------------------------- | ------------------------ | ---------------------- | ------------------------- |
| E-01               |                             |                                          |                          |                        |                           |

| Change / review | Defect and affected IDs | Correction | Passes invalidated | Fresh evidence / result |
| --------------- | ----------------------- | ---------- | ------------------ | ----------------------- |
|                 |                         |            |                    |                         |

## Budgets, deviations, and remaining work

- Scene performance budget / measured CPU, GPU, memory, draw calls and texture cost:
- Measurement conditions / untested platforms or views:
- Paid generation scope / remaining budget / unresolved jobs:
- User-approved deviations: criterion, actual status, waived gate, reason, approval reference, remaining impact:
- Blockers and next actions:

## Handoff gate

- [ ] Every required object is present and has current instance/asset criteria.
- [ ] Focused revision: preserved properties/relationships compared with baseline evidence in each required view/state, or justified N/A.
- [ ] Tripo provenance, applied Smart UV, PBR, metric scale, and materials verified.
- [ ] Whole layout and per-object visual reviews pass in Unity, including contact and visibility.
- [ ] Camera, lighting, atmosphere, and emission match the reference and project conventions.
- [ ] Motion, deformation, collision/contact, loops, and flicker checks pass or have justified N/A.
- [ ] Required views/platform budgets verified; explicit approved deviations linked.
- [ ] No stale passes, unaccounted temporary assets, or unexplained missing elements remain.
- [ ] Scene/prefabs and ledger saved; final comparison and motion evidence reviewed and linked.
- [ ] Agent verification, human art approval, limitations, and commit status stated separately.
