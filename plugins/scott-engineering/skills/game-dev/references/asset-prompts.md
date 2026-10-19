# Asset worker prompt templates

Combine this shared header with one stage brief. Replace every brace field with
the actual task data; omit fields that do not apply. The coordinator selects the
worker's provider and model using `SKILL.md`, then sends the completed prompt with
`--prompt-file` from a file or quoted heredoc. Attach reference images as needed.
These are worker instructions; derive generation prompts from their supplied brief.

## Shared header and handoff

```text
Parent: {parent_thread_id}. Asset: {asset_id}. Stage: {stage_name}.
Own only: {absolute_versioned_staging_directory}.
Final slot: {destination_for_reference_only}; never write to it.
Inputs: {accepted_paths_versions_and_roles}.
Contract: {version_and_path}; owned design decisions: {design_scope}.
Authorized output count: {count}. Budget: {budget_and_remaining_authority}.
Relevant tool facts: {version_host_help_excerpt_or_document_path}.
Hard checks for this stage: {counts_sides_surface_direction_and_technical_limits}.
Approximate targets and tolerances: {landmarks_style_targets_and_allowed_drift}.
Required evidence: {stage_checks_and_required_previews}.
Do the assignment yourself. Do not delegate or perform version-control work.
Preserve other workers' files and accepted inputs. Do not change the contract.
Report blockers and usable outputs promptly to the parent.
Never repeat an uncertain paid submission or expand the count or budget.
Handoff: asset ID, contract version, accepted input versions, saved output paths,
preview paths, orientation/format metadata, job IDs/receipts, checks and gaps.
Separate produced outputs from accepted outputs; the parent unlocks the next stage.
```

For design planning before a frozen contract exists, provide technical constraints
and the decisions Opus owns. It returns a proposed specification in staging for
the coordinator to record. Do not describe an unfrozen draft as an accepted contract.

For character or prop continuity, Opus derives a compact, versioned identity anchor
from the approved specification: silhouette, build, signature parts, palette, materials,
and exact feature counts and anatomical placement. Copy it unchanged into each
generation prompt, then add a separate block for what this pass changes. Keep
the full specification authoritative; the anchor summarizes it rather than
introducing a second contract. This adapts the
[fal character-anchor pattern](https://github.com/fal-ai-community/skills/blob/main/skills/character-design/references/anchor-system.md).

## Midjourney character exploration

Use this with the Opus design worker:

```text
Explore {character_role} using our Midjourney CLI; read
`midjourney skills get core` before generating.
Gameplay camera and scale: {camera_and_scale}.
Style references: {paths_and_visual_traits}.
Technical constraints: {dimensions_rig_equipment_and_budget}.
Preserve: {required_identity_or_lore_details}.
Explore only these choices: {silhouette_palette_material_or_costume_choices}.
Produce full-body concepts with readable silhouette and exposed anatomy.
Show the full head and feet, an uncluttered background, and exactly one character.
Include only approved props.
Use Fast by default unless another speed was explicitly requested.
Use only the authorized batches; do not silently enable draft or repeat.
Select one candidate and explain its fit at the gameplay camera.
Return the selected image/job/index and an identity specification covering
proportions, palette, materials, asymmetry, equipment, and hidden side/back details.
```

Opus can start its Midjourney generation prompt from this subject brief. Apply
model parameters separately using the current CLI guidance and authorized count.

```text
Full-body character concept for {game_style}: {character_role_and_identity}.
Identity anchor, when reusing an approved design: {unchanged_versioned_identity_summary}.
{silhouette_and_costume_direction}; {palette_and_materials}; {required_features}.
One subject, complete head and feet, clear readable silhouette, visible equipment.
{approved_art_style}; {background_and_lighting}; {gameplay_camera_readability}.
Preserve {identity_invariants}.
```

Append concrete exclusions as `--no` inside the quoted Midjourney prompt,
following [Midjourney's No parameter guidance](https://docs.midjourney.com/hc/en-us/articles/32173351982093-No).
The local CLI parses this prompt parameter; it is not a separate `imagine` option.

## GPT Image 2 reference views

Use this with the Codex image child:

```text
Read `imagegen`; use GPT Image 2 through the built-in `image_gen` tool.
If the tool/model is unavailable, report the blocker; do not switch to a paid API.
Inspect local images before editing. Concept reference image: {concept_path}.
Read the approved identity specification as text from {spec_path}.
Canonical front reference image, when available: {front_path}.
Reference authority: {front_and_spec_precedence_and_recorded_deviations}.
Identity anchor: {unchanged_versioned_identity_summary}.
This pass changes only: {camera_or_requested_canonical_front_corrections}.
Feature ledger: {count_anatomical_side_parent_surface_depth_and_normal_per_item}.
Per-camera visibility: {visible_hidden_or_edge_on_features_by_view}.
Produce this view set: {view_names_camera_definitions_and_filenames}.
Verified Tripo slot mapping and source: {slot_to_character_frame_and_evidence}.
Use the character's own left/right for anatomy, equipment and camera positions.
Translate to image coordinates explicitly for each fixed camera, e.g. character-left
is image-right in a frontal view; this projection is not an anatomical rename.
Pose: {neutral_pose}. Keep identical proportions, anatomy, equipment,
palette, materials, asymmetry, lighting, framing scale, and pose across views.
Required geometry visibility: {camera_compatible_pose_and_visible_gaps}.
Canvas and framing: {aspect_dimensions_subject_occupancy_and_all_edge_margins}.
Check that the projected pose can meet both occupancy and margins on that canvas.
Hidden details must follow the specification.
Use the prescribed background; show the whole body with clear limbs and feet.
No perspective exaggeration, labels, grid, scenery, or extra subjects.
Use one image per view. Establish the canonical front in the specified pose,
framing, lighting and background before the others, preserving design identity.
Return that front and pause for the parent's acceptance before remaining views.
For the other views, preserve that front and change only the camera viewpoint.
Stop if the accepted front and specification describe incompatible geometry.
Check one coherent object across the set; do not add hidden parts to expose them.
Check shared scale, sole line, waistline and equipment attachment locations.
Do not mirror side views or redesign occluded parts. Report undefined details.
Copy generated outputs from the tool's save location into your owned staging path.
Compare the matched set and report any identity, geometry, or orientation mismatch.
Return each usable view promptly for the parent's acceptance; do not start Tripo.
```

For an additional view after front acceptance, attach the front as image 1.
Attach another reference only for explicitly approved details compatible with it;
do not reintroduce a concept with stale proportions, pose or sides. Populate:

```text
Image 1 is the accepted canonical front and controls geometry and identity.
Identity anchor: {unchanged_versioned_identity_summary}.
Render one full-body view with camera {target_camera_position_and_direction}.
Preserve image 1's anatomy, proportions, neutral pose, palette, and materials.
Preserve these asymmetric details: {side_specific_equipment_and_markings}.
Approved hidden-side/back design: {hidden_surface_specification}.
For each attachment: {count_parent_anatomical_side_depth_surface_normal}.
Expected in this camera: {visible_hidden_or_edge_on_details}.
Example: one lens on the outer character-left plate face; face-on only from left.
A front or rear camera sees that same lens edge-on, never a new front/rear lens.
Change the camera viewpoint only. Keep the same body scale, lighting and backdrop.
Show the entire head, hands and feet with {framing_and_margin_requirements}.
No labels, panels, scenery, additional subjects, mirrored design, or new accessories.
```

Use the character's own frame for the camera and side-specific fields above;
do not describe anatomy as "image left" or "image right".

## GPT Image 2 exact edits and variants

Use this Codex brief for illustrations, UI art, or other precise edits:

```text
Read `imagegen`; use GPT Image 2 through the built-in `image_gen` tool.
Report unavailable tool/model access; do not silently switch to a paid API.
Open the edit target {target_path} with `view_image` before editing.
Input roles: {edit_target_reference_and_supporting_image_roles}.
Character or prop identity anchor, when applicable: {unchanged_versioned_identity_summary}.
Change only: {requested_changes}.
Preserve: {composition_identity_geometry_palette_and_other_invariants}.
Exact text, verbatim: {quoted_text_or_no_text_changes}.
Output contract: {dimensions_transparency_anchors_slices_and_format}.
Requested variants and count: {explicit_variant_list_and_authorized_count}.
Use one output per requested variant, preserving shared invariants.
Copy selected outputs into owned versioned staging; keep the source unchanged.
Compare each actual output with the target and report any unintended change,
text mismatch, alpha/slice issue, or unsupported requirement.
Return files, comparison previews and gaps; do not update the project yourself.
```

## Tripo model production

Use this with the Opus model worker:

```text
Use our Studio wrapper at ~/.local/share/cli-overrides/bin/tripo.
Read its `docs --llm`, `docs --topic parameters`, and `docs --topic quality`.
Input route: {image-to-model_or_multiview-to-model}; contract: {version_and_path}.
Accepted inputs: {single_reference_or_orientation_to_path_map}.
Generate geometry with tripo-p2 only and {face_budget_quad_and_symmetry}.
Never use text-to-model, P1 or H-series; text briefs require approved images.
Inspection export authority: {required_quad_preserving_format_and_budget_or_none}.
Finishing authority after candidate and cleanup-plan acceptance: {texture_rig_export_scope_and_budget}.
Visual priorities: {silhouette_identity_proportions_surface_appearance_and_gameplay_scale}.
Blender cleanup owner and scope: {owner_paths_repair_scope_and_budget}.
Cleanup/finishing order: {stage_order_and_uv_texture_skinning_preservation_or_rework}.
For a single accepted image, use `generate image-to-model`; do not generate views.
For multiview, require front plus another view, with the verified slot mapping
{slot_to_character_frame_and_evidence}; no contact sheet or guessed side convention.
Use exact front.png/left.png/back.png/right.png basenames in a versioned directory.
Keep identity, silhouette, proportions, materials, and asymmetry from the references.
Inspect solid/untextured and wireframe geometry before requesting texture.
Render cardinal and oblique views; count required items explicitly with evidence.
Report intersections, fused anatomy, stray components and topology measurements.
Rank candidates by visual quality; repairable diagnostic defects go in the Blender
cleanup list, not an automatic rejection. Do not seek perfect raw topology.
Inspect a quad-preserving export if required; triangulated GLB cannot prove quads.
Return the visual shortlist and cleanup plan; pause for their acceptance before
separately authorized finishing. Keep final-delivery checks separate.
If Blender cleanup comes first, use `tripo model import` on the edited mesh and
finish that new task. Later cleanup must preserve or rework affected UVs,
textures and skinning; do not finish the old raw task by accident.
Inspect and normalize the bundle to the contract in staging.
Tripo rig/preset scope: {supported_rig_family_and_presets_or_static_only}.
External/engine owner: {owner_for_custom_rig_clips_retargeting_and_events}.
Do not promise custom skeletons, arbitrary clips or engine events from Tripo.
Run only the required supported processing stages within the authorized budget.
Return all model/material/texture dependencies, solid/wireframe/oblique previews,
per-item counts and locations, loader extensions and required decoders, motions,
measured contract checks, known gaps, and source job IDs/receipts.
Do not change a prefab, scene, import setting, or final project asset yourself.
```

## Motion specification and in-game acceptance

Use this with the Opus design worker, including follow-ups to the same worker:

```text
Design/review {feature_and_required_states} at {actual_camera_or_display_scale}.
Technical constraints and captures: {paths_versions_and_roles}.
Motion evidence: {timestamped_frames_sampling_rate_and_measured_engine_timings}.
Specify hierarchy, key poses, duration, easing, loops, interruptions, and events.
Include interaction bounds and reduced-motion behavior when relevant.
For acceptance, inspect actual integrated screenshots and the time-indexed frames.
Use measured timings alongside the recording; do not claim to read a video directly.
Check readability, composition, lighting, deformation, timing, and motion feel.
Report concrete failures with frame/time or image locations and the responsible
asset/specification. Cite inspected frames/times and any evidence coverage gaps.
Return targeted corrections or an explicit accepted version.
Do not take control of the shared editor or rewrite gameplay interfaces.
```

## Music and sound effects

Use this with an audio worker whose execution settings match the primary thread:

```text
Produce {music_or_sfx} for {scene_or_event}. Use {Suno_browser_or_ElevenLabs_CLI}.
Mood and palette: {approved_mood_instruments_or_sound_character}.
Timing: {duration_event_times_loop_points_and_sync_requirements}.
Output contract: {format_sample_rate_channels_loudness_and_clip_ids}.
Music vocals: {instrumental_or_explicit_vocal_requirement}.
Use the authorized count and budget; keep source jobs and selected versions.
Listen to the saved audio, check its duration and any loop transition,
and return files, timing metadata, source receipts and remaining mismatches.
```
