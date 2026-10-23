The user selected 3D model · Tripo P2 for one output. Use game_studio_generate_3d_asset or game_studio_generate_canvas_media, then poll game_studio_generation. Follow the Tripo Studio
workflow in `game-dev` and inspect the selected node's image
references. Require an approved reference image; a connected image alone does
not establish visual approval. Use P2 Clean Topology and never text-to-model.
Confirm the asset contract and authorized paid-job budget before submitting.
Request authentication when required. Save geometry in the media folder's `staging/` (`canvas/staging/` on the canvas),
review the solid mesh and wireframe, and report its path and remaining cleanup.
This request does not authorize texture generation or additional outputs.

This adapter submits the node's Front input as the approved image, any connected
Left, Back and Right inputs as further multiview views, and the polygon target to
Tripo. Views must show one consistent subject at the same pose, scale and
lighting. The written model brief guides reference selection and review; it is
not a geometry constraint. Required forms must be visible in some view. Record
unseen requirements as inferred, then inspect them on the mesh.

Use a production reference with one complete subject, a plain white or light-gray
background, even diffuse lighting, and minimal occlusion. Aim for 70–85% frame
occupancy with clear margins; use a neutral A-pose or T-pose for characters when
the contract requires rigging. Do not use a scenic concept or contact sheet as
the single-image source. Preserve the approved silhouette and defining shapes.
Prefer an existing sharp reference around 1024 pixels square or larger as a
quality target, not an upload minimum. Check useful subject detail; enlarging a
blurred image does not recover missing forms. Reflections, transparency, and
baked shadows can hide geometry. Prefer an already-approved opaque or matte
reference when available, and retain the intended final materials separately.

Check solid and wireframe views for proportions, hidden-side artifacts, merged
parts, thin features, and topology. Assess engine scale, pivot, orientation,
budget, and game-camera readability separately; a generated mesh is not proof
of engine fit. Report which checks passed and what remains unverified.
