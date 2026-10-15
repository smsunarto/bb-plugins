Connect this Unity project to its exact running Editor. Read the project's Unity
and agent instructions, then use `unity-editors` to discover instances on the
project's enrolled host. Verify canonical project paths and distinguish the main
Editor from MPPM clones. Report the discovered instance and current owner.
If no Editor is running, inspect installed Unity versions and use the project's
Unity version through Unity Hub or the established launcher. Request license or
account authentication if needed. Preserve dirty scenes and other agents' focus.
Claim the appropriate Editor before controlling it. Main authoring is required
for shared Assets/Packages writes and scenario lifecycle; runtime inspection can
use an appropriate runtime claim. Do not bypass another thread's claim. Use
managed command/status/release for Pipeline operations, wait for tracked work to
finish, restore temporary state, and release when finished. Never take over or
reconcile another live owner's work.

If this thread's job state is uncertain, inspect status and use managed reconcile
only after proving native work is idle. If its Editor has gone away, use managed
recover only after verifying the Editor is dead and supplying the required
completion evidence. Do not infer completion from a missing process alone.
