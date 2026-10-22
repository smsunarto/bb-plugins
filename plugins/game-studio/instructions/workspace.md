# Game Studio workspace

This is a Unity game project opened in the BB Game Studio plugin, adapted from
WhiteTowerAI/ohmygame. The workspace is ordinary files: keep them useful outside BB.

Use `game-dev` for game planning, implementation, asset work,
and playtesting. Follow its asset inventory, contracts, parallel workers, and
acceptance process. Use Midjourney for visual exploration, Google Nano Banana 2.1 for image generation and edits, Gemini Omni for video, Fal H3 Max as an alternate video provider, Tripo Studio P2 Clean Topology for 3D geometry, ElevenLabs for speech
and sound effects, and the authenticated Suno browser for music. Request
authentication when the selected tool requires it. Never place credentials in
the game files, canvas, or browser bundle. Do not start paid jobs beyond the
user's requested scope or budget.

## Design and asset files

- `canvas/index.json`: version 1, boards `[{id,name}]`, documents `[{id,title}]`,
  optional `mainDocumentId` and tables `[{id,title}]`.
- `canvas/boards/<id>.json`: version 1 board with id, viewport `{width,height}`,
  nodes, edges. Nodes have stable id/type/data and optional title/description. Persisted node
  positions and sizes live in the editor layout; the UI hydrates them on read. Supported types: text, document, table, image, video, model-3d,
  animate-3d, and asset. Edges have id/source/target.
- `canvas/editor/<id>.json`: version 1 layout with view `canvas`, node positions
  keyed by id, and viewport `{x,y,zoom}`. Preserve user arrangement when changing
  content. Read the existing board and layout before updating either.
- `canvas/documents/<id>.md`: actual Markdown design documents.
- `canvas/requests/<id>.json`: progress for an accepted agent request, with
  `id`, `action`, numeric `createdAt`, `threadId`, `status`, and optional `detail`.
  Preserve the request identity. Use `running`, `done`, `failed`, or `uncertain`
  based on actual work and verification; an idle thread never proves completion.
- `canvas/staging/`: generated and uploaded images, audio, video, and models,
  pending verified import into Unity. Keep stable paths, preserve catalog entries,
  and use relative file paths. `Assets/` is touched only under the main Editor
  authoring claim; never use a lowercase `assets/` output folder in Unity.
  Game Studio frees canvas generations nothing uses: a node keeps the takes of
  its newest five runs, its starred takes and its pick, and a take nothing names
  goes after a week. Star a take, or name its asset on a board or in a document,
  to keep it.

Inspect current files before changing them. Preserve unrelated edits and detect
concurrent changes. Do not replace the entire canvas to add a node. Reference
other nodes with `{type:"node",nodeId}` and library assets with
`{type:"library",assetId}`. An image prompt is a request, not a finished asset.
Keep work in progress distinct from verified output.

## Art briefs and review

Connect each asset to its gameplay role and acceptance checks. Include subject,
silhouette, game camera, screen size, palette, materials, and lighting in the
brief. Label references by identity, style, composition, or pose. For revisions,
state what to preserve and the targeted change. Compare concepts before preparing
an isolated production reference for 3D. Review motion continuity and loop seams
when requested. Review solid geometry and wireframe before checking scale, pivot,
orientation, budget, and readability in the game. Record the selected candidate
and remaining cleanup; generation success alone does not establish acceptance.

## Unity ownership and integration

Discover and claim an exact Unity Editor through `unity-editors` before control.
Shared Assets/Packages writes and scenario lifecycle require the main Editor's
authoring claim. Use managed command/status/release for Pipeline operations.
Do not bypass another thread's claim, restart a dirty Editor, or steal shared
desktop focus. Finish tracked jobs and native work before releasing ownership.

Generated and uploaded assets are staged in `canvas/staging`, outside Assets.
Verify the contract before importing under the main authoring claim. Preserve
existing prefab identities, Unity `.meta` files, serialized references, material
slots, animation events, and gameplay bindings when replacing visual content.
Use the project's established assets structure and Unity importer settings.

Save playtest screenshots and recordings under `canvas/evidence` so the Evidence
tab can display them. Include meaningful filenames. Use the project's established
runtime driver and QA instructions; a screenshot is not an interactive playtest.
The Unity tab reports Editor discovery and ownership; it does not embed a live
Unity Editor. A built WebGL HTML entry can be opened through BB's file preview.
Use relative build asset URLs so it works through the leased preview subpath.

Interactive stories can use OhMyGame's documented graph and playable-node
conventions. Preserve the runtime and source format already present in a project.
Publishing requires an explicit user request; use BB's available sharing tools
or the game's existing deployment workflow.
