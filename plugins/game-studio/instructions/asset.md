Use `scott-engineering:game-dev` to produce the selected canvas asset. Inspect its
prompt, connected reference nodes, and existing project assets. Establish the
asset's contract and acceptance criteria before generation. Route visual
exploration to Midjourney, image work to Nano Banana 2.1, video to Gemini Omni or Fal H3 Max,
3D geometry to Tripo Studio P2, SFX and voice to ElevenLabs, and music to Suno.
Use the required Opus design and acceptance process. Ask the user to authenticate
when necessary. Do not submit a paid job without an authorized output scope and
budget. Save accepted outputs in `canvas/staging/`, outside Unity Assets, and update the catalog entry and
canvas asset reference, and verify the integrated consumer. Keep pending or
failed generation visible; do not claim success from a submitted job alone.

Before a paid submission, inspect the saved node and its existing generation
receipts. `recentNodeJobs` lists recent recorded jobs for this node or its linked
output. It is neither a complete history nor a live provider check. Read those
receipts and use `game_studio_generation` to reconcile an existing job by ID.
Queued, running, uncertain, auth-required, and locally cancelled jobs can still
represent provider work. Resume only a confirmed task; do not submit again just
because local waiting ended or a new composer request was prepared. Preserve the
existing request ID on retries. Review completed candidates against the current
brief before deciding whether another authorized output is needed. A changed
brief does not change an existing job's inputs; new work needs its own request ID.

Build the art brief from the current design decisions:

- Purpose: gameplay role and deliverable, such as concept, production reference,
  sprite, motion study, or geometry
- Subject: identity, silhouette, proportions, materials, and defining details
- View: game camera, framing, pose, and intended screen size
- Art direction: shape language, palette, surface treatment, and lighting
- References: label each input's role, such as identity, style, composition, or pose
- Revision: what to preserve, one requested change, and observable acceptance checks

Keep concept exploration distinct from a production reference. Compare concepts
for gameplay readability and consistency with the art direction. A 3D source needs
one complete, isolated subject, clear margins, even lighting, and minimal occlusion.
Do not convert a scenic concept or contact sheet into a single asset.

Review results at the intended game camera and screen size. For motion, inspect
continuity, camera behavior, action timing, and the loop seam when requested.
Review 3D shape and topology in solid and wireframe views before engine integration.
Then verify scale, orientation, pivot, materials, budget, and gameplay readability
in the consumer. Visual approval alone does not prove engine fit. Record the
selected candidate, reference paths, revision reason, and remaining cleanup.
