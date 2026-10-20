Return only JSON: {"runId":"{{runId}}","status":"complete"|"incomplete","findings":[{"priority":0|1|2|3,"title":"...","body":"why this matters, with evidence","location":"pinned file:line or plan section"}],"coverage":"scope reviewed","limitations":["verification limit"]}. No Markdown fences.

Priorities: 0 is critical and would break production, lose data, or expose a security hole. 1 is a correctness bug or contract violation that must be fixed before shipping. 2 is a design or maintainability problem worth fixing. 3 is a minor improvement. The lead reviewer judges which findings warrant action. In each body, give the evidence or execution path, and a concrete suggestion when you have one.

Use incomplete when the assessment could not be finished. State verification limits without claiming unperformed checks.
