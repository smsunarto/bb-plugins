---
name: game-studio
description: Work with Game Studio canvas projects in BB, including design documents, assets, agent work, and previews.
---

# Game Studio

Use this skill when the user refers to a Game Studio project, canvas node, or
design document. Use `game-dev` for production, tool selection,
parallel asset work, and playtesting. Authenticate with the selected service only
when needed; keep credentials outside the game workspace and browser bundle.

Read `game_studio_canvas_context` before design or media work. Use the native
`game_studio_generate_image`, `game_studio_generate_video`, or
`game_studio_generate_3d_asset` tools, or `game_studio_generate_canvas_media` for
a saved node. Provider CLI commands and credentials are internal details. Keep
a stable requestId and poll `game_studio_generation` to collect outputs. Resume
only a confirmed existing task; never resubmit an uncertain paid request.

Run `bb game-studio rpc overview '{}'` to list registered games. The plugin's RPCs are
also available through `bb plugin rpc game-studio`. Query `canvasContext` with `{"gameId":"..."}` for a bounded overview.
`get` returns the full workspace and can be large.
Use the returned project's host and root path; never assume the game lives on
the BB server. Inspect current CLI metadata for mutation input schemas.

Projects store their design as ordinary `canvas/` files compatible with the
OhMyGame workspace model: index, boards, editor layouts, Markdown documents,
and an asset catalog. Read the files before changing them. Keep content and
user layout separate and preserve stable node and asset identifiers.

Accepted requests carry a descriptor and a path under `canvas/requests/`. Keep
each request's independent progress JSON current, preserving `id`, `action`,
`createdAt`, and `threadId`. Use `running`, `done`, `failed`, or `uncertain` based
on actual verification. An idle thread is not proof of completion. After receiving the request in BB’s native chat, initialize its progress file
with your current thread id through `recordRequest` or the project files.
Preparing an unsent composer draft must not create progress files.

To update a document or board through RPC, send the revision returned by `get`.
A stale revision means someone else changed the file: reread and merge the
intended change. Do not retry with a new revision while discarding their work.

Use `updateGame` to set a verified web build's preview entry, for example
`{"gameId":"...","previewPath":"dist/index.html"}`. Static builds must use
relative asset URLs to load through BB's leased preview subpath. Use existing
engine tooling for native games. A loaded preview is not a completed playtest.

## Agent canvas workflow

Use the native canvas tools to author workflows instead of writing board-editing
scripts in each game repository. `game_studio_canvas_context({gameId})` lists
boards and their revisions. Read one board with `{gameId,boardId}`; use
`nodeIds:["concept"]` to focus a correction. Follow `nextOffset` until null.
The CLI's matching read is `bb game-studio rpc canvasContext '{"gameId":"..."}'`.
The main document is returned as a path and revision; read it when design context
is needed. `section:"assets"` or `section:"documents"` pages those catalogs.
`omittedDataKeys` names bulky fields. To recover one exactly, request
`field:{nodeId:"concept",key:"prompt",offset:0,limit:8000}` and join the returned
chunks using `nextOffset`. `encoding:"json"` means parse the joined JSON.

`game_studio_canvas_edit` takes the board's exact revision and a batch such as:

```json
{"gameId":"...","boardId":"...","revision":"...","dryRun":true,"operations":[
  {"op":"add_node","node":{"id":"direction","type":"text","data":{"text":"Match the approved HQ render and character references."}}},
  {"op":"add_node","node":{"id":"concept","type":"image","data":{"prompt":"Urban Tokyo HQ exterior","review":{"enabled":true,"retries":0,"criteria":"Match the approved materials and character identity."},"judge":{"enabled":true}}}},
  {"op":"connect","id":"direction-concept","source":"direction","target":"concept","port":"text"}
]}
```

Inspect the dry run, then send the same batch without `dryRun`. On later edits,
patch only the changed brief fields; generated outputs and existing positions
survive. Use `connect`/`disconnect` for node inputs and `move_node` for explicit
positions. Use `connect_asset` with target, assetId, and optional port for library images.
To replace a library or legacy wireless input, use `remove_input` with the
node id and `input:{key:"references",index:0}` (or key images), then reconnect
in the same batch. `input:{key:"promptSource"}` removes a linked prompt.
Indexes address the arrays in the exact context revision. Library inputs can
also be supplied in a new node's data.images/references. Non-image catalog
assets cannot be used as library images.
A stale revision rejects the entire batch, including a dry run: reread and merge.
Do not replace whole boards to fix one node. Use the UI's Arrange button when
real card measurements are needed; estimated coordinates are not visual proof.

Review and judge are settings on media nodes, not separate node kinds. Keep
retries at zero until the user authorizes a paid retry scope. Generate, collect,
inspect, and review the candidate before accepting it downstream. Request an
existing output review with `reviewAssetId`, or a comparison with `judge:true`,
on `game_studio_generate_canvas_media`; choose only one of brief/review/judge.
Each action uses a distinct stable requestId. Preserve approved architecture
when correcting shader/material style, and reuse the approved render, character,
logo, and moodboard references on every dependent node.

A 401 from a web URL does not establish that the native canvas requires sign-in.
Use the user's browser routing for screenshots; keep the failure scoped to the
capture method. A schematic is not a screenshot of the canvas. Close only the
preview or playback sessions this task started.
