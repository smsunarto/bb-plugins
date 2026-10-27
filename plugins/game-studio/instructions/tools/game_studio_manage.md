Coordinate Unity Editor ownership between BB threads. Use this to claim or reserve an Editor; run Editor operations through the Unity CLI against the claimed instance, not through this tool.

CHOOSING BETWEEN TOOLS
Use `game_studio_slots` to lease a registered Rampage checkout. Use this tool to coordinate its exact Editor, or Editors in checkouts without registered slots.

BEFORE CALLING
For instance actions, list Editors, then select the exact `instanceId`. A returned `claimId` can identify its instance on later calls. Use `workspacePath` for `reserve`, and for `release`, `request`, or `recover` when targeting a checkout reservation. Operations target the thread's enrolled host unless `hostId` selects another enrolled host.

OWNERSHIP ACTIONS

- `list` shows Editors, claims, and reservations by checkout. `peek` reads an Editor's idle state and public owner without claiming it.
- `claim` acquires an exact instance; `wait` blocks until it is claimable, then claims it. Runtime claims coexist and permit read-only inspection, including MPPM clients. Authoring excludes every other thread on the shared checkout and is required for Assets/Packages writes, imports, and scenario lifecycle. Clones cannot author.
- `reserve` holds `workspacePath` before `unity open`, so the new Editor is yours from discovery. `request` asks the owner blocking an `instanceId` or `workspacePath` for a handoff; include a reason.
- `status` returns native idle state as `background.quiet`. After checking the Unity CLI's served PID matches `instance.pid`, operate against the claim's exact `instance.projectPath`. Write only while `background.quiet` is true.

RELEASE AND RECOVERY

- Claims and reservations release automatically at the owning thread's turn end when the Editor is quiet, out of Play mode, and has no unsaved scenes, unless `hold:true` keeps them for continuing work or an agreed preview handoff. Re-claim at each turn's start.
- Before `release`, stop Play, settle scenes while preserving dirty work, finish detached CLI jobs, and coordinate host focus, capture, and simulated input with other owners.
- Conflicts name the owner and its state. Use `wait` or `request`, or open an Editor in your own worktree; do not bypass ownership.
- `recover` handles dead Editors, archived/deleted owners with evidence, or orphaned reservations selected by `workspacePath`. `reconcile` handles pre-upgrade jobs. Explicit completion evidence and confirmation are required where those operations request them.
