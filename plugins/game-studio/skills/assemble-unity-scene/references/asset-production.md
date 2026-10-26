# Asset production gates

## Allocate detail for the actual view

Assign a triangle budget per asset and for the visible scene using its largest
projected size at the nearest supported camera, silhouette complexity, motion,
shadow/reflection contribution, instance count, and target device. Record the
reason and actual imported triangle/vertex counts; do not give every prop the
same arbitrary polygon count. Small texture details rarely justify geometry,
while a hero silhouette, articulation, and deformation can require it.

Plan LODs for relevant viewing distances and inspect their transitions at output
resolution. Include materials/submeshes, texture memory, transparency overdraw,
skinning, and draw calls in the budget. Triangles alone do not predict frame time.
Use the project's existing performance envelope; if absent, record a provisional
budget and its assumption, then validate on the target device before passing it.

## Generate and verify metric geometry

State dimensions in meters, physical construction, complete extremities, and
required openings in the approved image/reference brief. Use consistent front,
left, back, and right views when they resolve ambiguity. Feed approved imagery
to Tripo P2 Clean Topology through Game Studio; text-only descriptions are not
approved front images. Set `targetPolycount` from the intended viewing budget
within the current tool's accepted range (currently 1,000–200,000). This is a
provider request, not a guaranteed triangle count: the imported count determines
budget compliance. If the desired budget falls outside supported generation or
processing limits, record the constraint rather than claiming it was met.

Inspect the solid model and wireframe from all sides before finishing. Reject or
correct chopped extremities, missing backs/undersides, sealed openings, warped
proportions, paper-thin structural parts, stray islands, obvious holes, bad normals,
and self-intersections that would be visible, break shadows, or impede animation.
Use Tripo processing/regeneration for geometry corrections within scope; no
hand-built replacement geometry. Review again after topology-changing operations.

Verify imported mesh bounds and known dimensions against **1 Unity unit = 1 meter**.
A generation prompt or a root scale of one is not evidence of physical size.
If source units need calibration, apply one documented uniform import conversion
and remeasure all axes, pivots, attachments, collider sizes, and animation root
motion. Keep the prefab root at unit scale where the importer supports it and
verify the resulting world dimensions including parent transforms. Regenerate
incorrect proportions; do not nonuniformly distort or camera-size objects to
disguise them. Establish an intentional pivot and ground/contact datum.

## Apply Smart UV, texture, and PBR

Use saved `model-3d` nodes and exact board revisions. Connect processing inputs
through the `model` port. For fresh geometry the sequence is:

`Tripo P2 (model-3d) → tripo-smart-uv → tripo-apply-uv → tripo-texture → tripo-pbr`

1. Run Smart UV and collect its candidate. Inspect the candidate in the model
   viewer's UV mode: seams, island coverage, padding, stretch, texel density, and
   unintended overlaps. Distinguish reusable material UVs from unique baked
   lightmap UVs; shared/tiled texture coordinates can be intentional.
2. Select the accepted take and connect it to Apply UV. Run and collect Apply UV
   before connecting to texture/PBR. A Smart UV candidate alone is not an applied
   mesh. The plugin carries saved task/operator identities; do not invent them.
3. Texture against the approved reference, then run PBR and inspect the actual
   outputs. Existing textured Tripo assets can reuse their finishing only with
   evidence of the applied Smart UV and PBR results. Record job IDs, chosen takes,
   asset paths/hashes, and derived outputs. Locally modified UV candidates need
   regeneration before application; inspect current tool contracts before changes.
4. Verify maps in Unity after shader conversion, not just in the provider preview.
   Preserve base color, normal detail, roughness/smoothness, metallic, occlusion,
   and emissive intent. Discover the actual ZLZ property names, channel packing,
   keywords, and import expectations from shader source and working materials.
   Do not assume glTF maps bind directly to those shaders.

For animation, follow the verified processing order with `tripo-rig` and
`tripo-animate` as needed. Inspect the final rigged/animated output again for
renderable meshes, material/UV preservation, scale, and full motion bounds.

## Reuse surfaces deliberately

Inventory compatible shared materials and texture sets before generating unique
ones. Reuse tileables, trim/atlas regions, and material instances when UV layout,
physical texel density, palette, and wear language agree. Keep intended variation
and distinguishing marks; never assign an unrelated baked atlas to new UVs.
Reproject/retexture when layouts differ and repeat the finishing checks.

Record which assets share each texture, resolution/mips, compression and platform
override, channel packing, and measured memory/build cost when available. Check
at target resolution for stretched patterns, seams, bleeding, shimmering,
inconsistent texel density, and duplicated textures. Preserve generated originals
and maintain explicit links to Unity material/texture derivatives.

Emissive features need a correctly mapped emission texture/mask and HDR material
intensity suitable for bloom. A bright patch in base color does not prove emission.
If Tripo's result omits emission, produce a derived mask from the accepted texture
or correct/retexture within the authorized scope, record its provenance, and verify
the complete ZLZ emission/bloom path. Bloom and illumination of nearby surfaces
are separate effects. Add light spill only when the target or an explicit scene
criterion requires it, using the project's supported lighting solution.
