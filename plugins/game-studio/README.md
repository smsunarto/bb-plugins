# Game Studio

Game Studio is a web app: its design documents, canvas, assets, evidence,
generation jobs and approvals live in the Game Studio Worker (the Argus
monorepo's `apps/game-studio`, served at `https://studio.argus.dev` behind
Cloudflare Access). This BB plugin is one of its clients. It embeds the studio
beside your threads, gives agents the studio's API as native tools, relays the
studio's approval forms into the thread, and lends the studio BB threads for
agentic work. Unity Editor coordination stays here, because it is about BB
threads and machines rather than the studio.

The canvas file model and studio workflow are adapted from
[WhiteTowerAI/ohmygame](https://github.com/WhiteTowerAI/ohmygame); the adapted
code now lives with the web app, and this plugin keeps the notice for the
adapted text that remains.

## Set up

In the plugin's settings:

- **Game Studio URL**: the studio's origin, `https://studio.argus.dev` by
  default.
- **Cloudflare Access client ID** and **client secret**: an Access service token
  the studio's Access application accepts. The plugin sends it on every API
  call; agents never see it. Until both are set, the panel still embeds the
  studio, but the agent tools and mentions report what to set.

The studio reaches BB through the plugin's HTTP routes under
`/api/v1/plugins/game-studio/http/` (`/ping`, `/threads/spawn`, `/threads/get`,
`/threads/output`, `/threads/stop`), authenticated with the per-plugin token
(`bb plugin token game-studio`). On the BB server those routes sit behind a
Cloudflare Tunnel with its own Access service-auth policy, and the Worker holds
that service token and the plugin token as secrets.

## In BB

- **Game Studio tab** in a thread, the new-thread panel, the thread header
  button, and the **Game Studio** sidebar entry all embed the studio. A thread
  that works on a game opens that game; the game's **Settings** page in the
  studio names the BB project, machine and checkout it is connected to.
- The embedded studio runs in your browser on the studio's own origin. If a
  browser keeps the Access sign-in cookie out of the frame, the panel's **Open**
  link opens the studio in a tab; sign in there and reopen the panel.
- Studio buttons that ask the agent add a prompt and a **Game Studio** context
  pill to the composer beside the panel. The pill resolves the studio's prepared
  context when you send. Outside BB the same buttons copy the prompt.
- `@` a canvas node in the composer to hand the agent its brief, inputs and
  output image.
- A paid generation an agent starts asks you first through a form in the
  thread. Approval covers the run's batch and its review retries; the checkbox
  approves the game's later agent runs until you turn that off in the studio's
  Settings.
- The thread's **Info** tab shows the game it works on.

## Agent tools

`game_studio_canvas_context` reads boards, nodes, assets and documents with the
revisions the other tools need. `game_studio_canvas_edit` changes a board
atomically and may run a node. `game_studio_generate_image`, `_video`,
`_3d_asset` and `_canvas_media` start generations; `game_studio_generation`
collects, resumes or cancels one. Each tool calls the studio's API for the
thread's game; a thread must work in the game's connected BB project and
checkout to edit or generate. Provider credentials belong to the Worker: Google
Vertex AI for Nano Banana and Gemini Omni, and Fal for H3 Max. Midjourney and
Tripo are not available in the Worker yet; the studio's **Models** list says
which providers are configured.

## Unity

Game Studio includes Editor discovery, managed ownership, and persistent Rampage
checkout slots. Use `game_studio_manage` and `game_studio_slots`, or
`bb game-studio manage` and `bb game-studio slots`. Unity CLI operations, imports
into `Assets`, package edits, and scenario lifecycle require the agent's exact
Editor claim. The `unity-rampage-slot` environment provider lets a new thread
pick a registered checkout.

When upgrading from the separate Unity plugin, follow the environment
re-adoption procedure before disabling it. Game Studio imports its claims,
leases, and provisioning receipts once from the old database, preserving
ownership and pending jobs. Interrupted checkout preparation remains quarantined
for explicit recovery. The provider ID remains `unity-rampage-slot`, but BB also
binds environments to their owning plugin, so existing Unity-owned environments
require re-adoption.

## Development

The plugin depends on `@argus-labs/game-studio-api` from the monorepo's
`pkg/game-studio-api`, linked with `bun link` while the API settles. This
plugin's checks are `bun run typecheck`, `bun run test`, `bun run check`, and
`bun run build` from its directory; the tests stand in a fake studio behind
`fetch`, so they need no Worker.

Game Studio is MIT licensed; see [LICENSE](LICENSE). The adapted OhMyGame source
is Apache-2.0; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
