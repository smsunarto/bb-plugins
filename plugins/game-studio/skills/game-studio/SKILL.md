---
name: game-studio
description: Work with Game Studio canvas projects in BB, including design documents, assets, agent work, and previews.
---

# Game Studio

Use this skill when the user refers to a Game Studio project, canvas node, or
design document. Use `game-dev` for production, tool selection,
parallel asset work, and playtesting. Authenticate with the selected service only
when needed; keep credentials outside the game workspace and browser bundle.

For assembling or revising a Unity scene against a Game Studio render target,
read [assemble-unity-scene](../assemble-unity-scene/SKILL.md). It owns the living
`SCENE.md`, Tripo asset acceptance, and integrated visual handoff checks.

Read `game_studio_canvas_context` before design or media work. Use the native
`game_studio_generate_image`, `game_studio_generate_video`, or
`game_studio_generate_3d_asset` tools, or `game_studio_generate_canvas_media` for
a saved node. Provider CLI commands and credentials are internal details. Keep
a stable requestId and poll `game_studio_generation` to collect outputs. Resume
only a confirmed existing task; never resubmit an uncertain paid request.

Run `bb game-studio rpc overview '{}'` to list the studio's games and the studio's
URL, and `game_studio_canvas_context` with `{"gameId":"..."}` for a bounded overview.
The studio's files live in the Game Studio web app, not in the game's checkout:
read and change them only through the native tools. A paid generation an agent
starts waits for the person's approval there, and an edit made there is shown to
the person with an undo. A game connected to a checkout accepts edits and
generations only from threads in that BB project and checkout; the overview names
them under `checkout`.

The studio keeps a game's design as the OhMyGame workspace model: index, boards,
Markdown documents, and an asset catalog. Keep content and layout separate and
preserve stable node and asset identifiers. A stale revision means someone else
changed the file: reread and merge the intended change rather than retrying
over their work.

A request the person sends from the studio arrives with a context pill that
carries its descriptor. Report progress in the thread; an idle thread is not
proof of completion. Preparing an unsent composer draft records nothing.

Builds and playtests happen in the game's checkout with the engine's own
tooling. A loaded preview is not a completed playtest.

## Agent canvas workflow

Use the native canvas tools to author workflows instead of writing board-editing
scripts in each game repository. `game_studio_canvas_context({gameId})` lists
boards and their revisions. Read one board with `{gameId,boardId}`; use
`nodeIds:["concept"]` to focus a correction. Follow `nextOffset` until null.
The main document is returned as a path and revision; read it when design context
is needed. `section:"assets"` or `section:"documents"` pages those catalogs.
`omittedDataKeys` names bulky fields. To recover one exactly, request
`field:{nodeId:"concept",key:"prompt",offset:0,limit:8000}` and join the returned
chunks using `nextOffset`. `encoding:"json"` means parse the joined JSON.

`game_studio_canvas_edit` takes the board's exact revision and a batch such as:

```json
{
  "gameId": "...",
  "boardId": "...",
  "revision": "...",
  "dryRun": true,
  "operations": [
    {
      "op": "add_node",
      "node": {
        "id": "direction",
        "type": "text",
        "data": { "text": "Match the approved HQ render and character references." }
      }
    },
    {
      "op": "add_node",
      "node": {
        "id": "concept",
        "type": "image",
        "data": {
          "prompt": "Urban Tokyo HQ exterior",
          "review": {
            "enabled": true,
            "retries": 0,
            "criteria": "Match the approved materials and character identity."
          },
          "judge": { "enabled": true }
        }
      }
    },
    {
      "op": "connect",
      "id": "direction-concept",
      "source": "direction",
      "target": "concept",
      "port": "text"
    }
  ]
}
```

Inspect the dry run, then send the same batch without `dryRun`. Add
`run:{nodeId,requestId}` to generate a node of the edited board once the edit is
saved; the person approves a paid run before anything is saved, and a decline
leaves the board unchanged. Each saved edit returns an `editId`; the person sees
what it changed and can put it back, so send one coherent batch per change.
When the person `@`-mentions a canvas node in chat, its brief, inputs, output,
board revision, and ids arrive as context; read it in full with
`game_studio_canvas_context` before editing. On later edits,
patch only the changed brief fields; generated outputs and existing positions
survive. Use `connect`/`disconnect` for node inputs and `move_node` for explicit
positions during the current visit. Opening a board automatically arranges its
measured cards, so explicit positions are recomputed on reopen. Use `connect_asset` with target, assetId, and optional port for library images.
To replace a library or legacy wireless input, use `remove_input` with the
node id and `input:{key:"references",index:0}` (or key images), then reconnect
in the same batch. `input:{key:"promptSource"}` removes a linked prompt.
Indexes address the arrays in the exact context revision. Library inputs can
also be supplied in a new node's data.images/references. Non-image catalog
assets cannot be used as library images.
A stale revision rejects the entire batch, including a dry run: reread and merge.
Do not replace whole boards to fix one node. Opening the canvas arranges measured cards automatically; the Arrange button
can repeat this during a visit; estimated coordinates are not visual proof.

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
