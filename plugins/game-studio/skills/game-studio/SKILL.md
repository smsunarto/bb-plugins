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

Run `bb game-studio rpc overview` to list registered games. The plugin's RPCs are
also available through `bb plugin rpc game-studio`. Query `get` with
`{"gameId":"..."}` for the current canvas, design documents, and asset paths.
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
