# Game Studio

A native BB studio for Unity projects, adapted from
[WhiteTowerAI/ohmygame](https://github.com/WhiteTowerAI/ohmygame). Keep your BB
conversation in BB’s native main chat. The Unity workflow, design document,
asset canvas, staging library, and playtest evidence live in BB’s right sidebar.

Open **Game Studio** from a thread’s panel launcher or header button.
The navigation gallery opens projects beside their native BB thread. Studio
contains no embedded chat or composer. Actions add a request to the main chat’s
native composer for you to review and send; BB owns the agent and its settings.
Select its enrolled machine and enter the absolute Unity project directory. The
connection checks `ProjectSettings/ProjectVersion.txt` and `Assets`. **New
project** creates a design workspace with your selected Editor version and
3D URP, 2D URP, or Empty template; the agent then uses Unity's actual project
creation tooling. Leave the version unset to let the agent choose through Hub.

## Work in Unity

- **Unity:** project version, discovered Editors and their ownership, and agent
  requests to connect, implement, import, or playtest. Recent requests show
  file-backed Queued, Running, Done, Failed, or Uncertain progress reported by
  the agent; a thread becoming idle does not mark work done.
- **Design:** editable Markdown documents with explicit saves and disk-conflict
  handling.
- **Canvas:** boards with draggable notes, documents, image/video/3D requests,
  audio assets, and reference connections. Save a board before requesting assets.
- **Assets:** upload to `canvas/staging`; browse imported media under
  `Assets/GameStudio`. The agent verifies and imports staged files using the
  project's established asset structure.
- **Evidence:** screenshots and recordings saved under `canvas/evidence`. Unity
  WebGL builds can also be opened through BB's leased file preview.

The agent uses `scott-engineering:game-dev`: Midjourney for visual exploration,
GPT Image 2 for precise image work, Tripo Studio P2 for 3D geometry, ElevenLabs
for speech and SFX, and Suno for music. The selected tool handles authentication
when needed. Asset buttons prepare a request for you to review and send to your
BB agent; they do not submit generation jobs themselves.

Install the **Unity** plugin for Editor discovery and managed ownership.
The studio reads its public `listUnityEditors` RPC. Editor control, imports into
`Assets`, package edits, and scenario lifecycle go through the agent's exact
Editor claim. The studio does not take claims or control Unity from its UI.

## Files and collaboration

Design files use the upstream canvas workspace layout: `canvas/index.json`,
`canvas/boards/*.json`, `canvas/editor/*.json`, `canvas/documents/*.md`, and
`canvas/assets.json`. Editor layout stays separate from board content. Existing
project files, including `AGENTS.md`, are preserved. Save operations compare
file hashes and reject stale writes, retaining the editor draft.
Agents keep independent progress files for accepted requests at
`canvas/requests/<id>.json`; drafts create no request history. The studio reads
up to 1,000 request files and shows the newest five valid records.

Each game is bound to its BB project, machine, and directory. A linked agent
thread must use that same checkout; another worktree does not share the studio's
files. BB's remote file APIs serve media on the correct enrolled machine.

## Development

From this repository, use the workspace dev loop and isolated verification
workflow. This plugin's checks are `bun run typecheck`, `bun run test`,
`bun run check`, and `bun run build` from its directory.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the pinned upstream source
and [LICENSE](LICENSE) for Apache-2.0 terms.
