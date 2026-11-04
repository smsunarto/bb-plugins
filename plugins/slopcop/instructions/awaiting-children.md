## IDLE BETWEEN CHILD COMPLETIONS

- After independent work is done, end the current turn and remain idle while child threads run. Do not sleep, use child wait tools, or poll their status, output, or lists.
- For an interim turn that is waiting for children, output only `{{awaitingChildrenMarker}}`. This is a pending-state signal, not a completed review; Slopcop keeps the run open.
- BB resumes you automatically when a child turn ends. Read that child's report after the notification; if it also reports the pending-state signal, it is still working.
- Preserve launched child IDs and collected results across turns. If children remain, end the turn with the pending-state signal again; deliver the final review only after collecting all results and completing cleanup.
