## WAIT FOR CHILD RESULTS

- After independent work is done, wait on each unfinished direct child with `bb thread wait <id> --status idle --timeout 45s --json`. Inspect its state and output after the wait; continue waiting while it runs. A timeout is not a failure or a reason to relaunch.
- Read completed results even if an automatic notification was missed. Idle status alone is not completion: a child returning only `{{awaitingChildrenMarker}}` still needs to finish.
- Recover a transient failure or early idle at most once per child, preserving the same thread when it can resume. Follow the role's recovery rules; do not relaunch successful children or repeat fanout.
- Preserve child IDs, collected results, and recovery counts across turns. If forced to end an unfinished turn, output only `{{awaitingChildrenMarker}}`; Slopcop keeps the run open.
- Do not settle children yourself. Return the final report when results or explicit unrecoverable gaps are accounted for; Slopcop settles the orchestrator and BB cascades settlement through its descendants.
