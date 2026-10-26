# Unity visual acceptance

Use the project's installed Unity and pipeline versions as the contract. The
sources below establish production practices; their settings are not a preset
to copy into every project. Record observable pass conditions in `SCENE.md`.

## Camera, layout, and visibility

- Compare the same aspect ratio, resolution, camera, render scale, pose, and
  exposure state. Inspect target and Unity captures side by side; use overlays
  only with honest alignment and without stretching. Check horizon, vanishing
  direction, silhouette extents, overlaps, negative space, and focal hierarchy.
- Verify perspective/orthographic projection, position/rotation, FOV or size,
  and physical-camera sensor/focal length/lens shift/Gate Fit where used. Aspect
  mismatch can change cropping even when camera transforms are identical.
- Inspect support and contact from the target and oblique views: feet on floors,
  props on surfaces, doors/openings with depth, believable joins, no unintended
  penetration, hovering, z-fighting, or detached shadows. Colliders do not prove
  that the rendered meshes make contact.
- Move through all supported camera and animation states. Check near/far planes,
  layer masks, renderer bounds, occlusion, shadow distance, LOD transitions, and
  final LOD culling. Preserve intentional reference crops/occlusions, but reject
  missing required geometry, popping, and clipped effects.
- Verify bounds for skinned meshes, vertex-displaced materials, particles, and
  VFX over their full motion. Imported skinned bounds can miss later bone motion.
  Fix bounds for the actual envelope; enabling offscreen updates everywhere has
  a runtime cost and is not a general solution.

## Materials, light, and atmosphere

- Read the target project's shader policy and approved material templates before
  assigning shaders. In Rampage, consult the current checkout's
  `.agents/skills/verify-rampage/features/zlz-shaders.md` and its Character,
  Environment, and rendering references when present. That policy assigns
  `ZLZ/AnimeToon/Character` to characters and discrete props and
  `ZLZ/Environment/Shader` to architectural surfaces, and preserves specialized
  effects. Follow current project rules;
  never infer the shader solely from an object's name.
- Match the renderer/quality asset, color space, light setup, Volume overrides,
  tonemapping, exposure, grading, AA, shadow policy, and reflection/probe setup
  to representative project scenes. Custom ZLZ effects may depend on renderer
  features. Preserve existing renderer ownership; do not run vendor installers
  or swap pipeline assets just to make one material work.
- Verify actual texture slots and keywords, normals/tangents, roughness to
  smoothness conversion if needed, mask packing, and color/data import settings.
  Check both neutral material inspection and final scene illumination. Preserve
  the target's material separation, wear, palette, and texture scale.
- Match key light direction and softness, fill/rim balance, color temperature,
  highlight placement, shadow density, and mood. Inspect shadow acne, excessive
  bias, detached contact shadows, light leaks, baked seams, probe transitions,
  and reflection inconsistencies. Rebuild affected lighting data when needed.
- Check emissive mask placement, material HDR output, visible bloom, and required
  spill on neighboring objects separately. Verify the camera/post-processing
  path, active Volume, bloom threshold/intensity, and exposure; retain readable
  luminous detail rather than blowing it out. A PBR export does not prove these.
- Review sky, fog/haze depth and density, water/liquid surfaces and edges,
  refraction/reflection, particles, and weather in context. Check transparency
  sorting, clipping/intersections, particle bounds, draw order, and overdraw.
  Effects should reinforce the target's depth and mood without masking defects.

## Animation and temporal stability

- Play complete clips, transitions, loops, entrances/exits, and representative
  interactions at normal speed. Then scrub contact phases, extremes, fast motion,
  and loop seams. Capture both the target view and diagnostic views where needed.
- Inspect skin attachment, bind pose, joint bending, weight collapse, twisting,
  excessive stretch, unnatural poses, foot sliding, root drift, and prop/grip
  alignment. Check all moving relationships: body/clothes, limbs, carried items,
  ground, surrounding props, and other animated objects. Nothing should ghost
  through another object unless explicitly intended by the brief.
- Check root motion, speed, timing, pose continuity, collision/contact, and loop
  continuity in Unity. Endpoint equality alone cannot prove a natural loop or
  plausible intervening motion. Inspect the final asset after rigging/retargeting.
- Review lighting/shadow flicker, LOD popping, texture shimmer, emissive/bloom
  instability, temporal-AA trails, particle spawn/expiry, fog/water motion, and
  reflection changes. Move camera/lights and exercise the actual quality tier.
  Overlapping shadowed lights can exceed pipeline limits and flicker; diagnose
  the cause rather than hiding it with brightness or blanket quality increases.
- Record playback duration, timecodes, capture rate, platform, scene revision,
  and any controlled random seed. Inspect a representative normal run as well
  as reproducible diagnostic states. Stills cannot pass temporal criteria.

## Runtime and final review

- Profile the integrated scene using the intended hardware, resolution, quality,
  and representative worst visible state. Check CPU/GPU frame time, memory,
  textures, batches/materials, skinning, shadows, and transparent effects against
  the recorded budget. Use Unity Profiler/Frame Debugger or project equivalents
  to diagnose; record measurement conditions and untested platforms explicitly.
- Inspect captures after optimization, LOD, compression, or lighting changes.
  Recheck silhouette, UV/detail readability, emission, motion, and the complete
  target composition. Saving triangles does not justify a visible regression.
- Reopen or reload the saved scene with the final assets and capture the accepted
  state. Verify no missing shader/material, temporary asset, stale bake, or
  unsaved-only fix is responsible for the successful preview.

## Research sources

Reviewed 2026-10-26. Follow documentation for the project's installed version.

- [Unity Learn: concept art to prototype blockout](https://learn.unity.com/course/snaps-prototypes-related-tutorials/tutorial/creating-a-prototype-blockout-from-concept-art)
  grounds the full-layout-first sequence in architecture, focal points, modular
  reuse, and player visibility. Here, coarse assets are Tripo-generated.
- [Naughty Dog at GDC: Cinematic Environment Production for Uncharted 4](https://www.youtube.com/watch?v=bEIX-EQNZuQ)
  connects composition, light, spacing, shape, camera, and motion to emotional
  intent; object presence alone is insufficient acceptance.
- [Unity 6 model import settings](https://docs.unity3d.com/6000.0/Documentation/Manual/FBXImporter-Model.html)
  documents metric scale and import transforms. GLB importers have their own
  behavior: measure their actual Unity result.
- [Unity 6 physical cameras](https://docs.unity.com/en-us/engine/6000.0/manual/cameras/physical/introduction)
  explains sensor, focal length, and Gate Fit effects on framing.
- [Unity 6 URP asset reference](https://docs.unity.com/en-us/engine/6000.0/manual/render-pipelines/universal-render-pipeline/urp-reference/universalrp-asset)
  covers the pipeline/quality settings that affect the rendered appearance.
- [Unity 6 bloom](https://docs.unity3d.com/6000.0/Documentation/Manual/urp/post-processing-bloom.html)
  explains bright-region thresholding, intensity, and filtering tradeoffs.
- [Unity 6 skinned mesh visibility](https://docs.unity3d.com/6000.0/Documentation/Manual/troubleshooting-skinned-mesh-renderer-visibility.html)
  describes motion beyond imported bounds and the cost of offscreen updates.
- [Unity 6 LOD Group](https://docs.unity3d.com/6000.0/Documentation/Manual/class-LODGroup.html)
  defines screen-height thresholds, final culling, and crossfade requirements.
- [Unity 6 URP shadow troubleshooting](https://docs.unity3d.com/6000.0/Documentation/Manual/urp/shadows-troubleshooting-urp.html)
  covers bias, detached shadows, light leaks, and light-limit flicker.
- [Unity 6 target-device profiling](https://docs.unity3d.com/6000.0/Documentation/Manual/profiling-target-device.html)
  explains why Editor measurements cannot establish release-device performance.
