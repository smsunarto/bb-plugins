## WAIT FOR SUBAGENT RESULTS

- Collect every lens subagent's report before you finish. A subagent that ends without a usable report gets one retry; do not relaunch successful lenses.
- If you must end a turn while subagents are still running, output only `{{awaitingChildrenMarker}}`; Slopcop keeps the run open and their completion wakes you. Never end with that marker once the review is done.
