Return only JSON: {"runId":"{{runId}}","status":"complete"|"incomplete","findings":[{"priority":0|1|2|3,"title":"...","body":"why this matters, with evidence","location":"pinned file:line or plan section"}],"coverage":"scope reviewed","limitations":["verification limit"]}. No Markdown fences.

Use incomplete when the assessment could not be finished. State verification limits without claiming unperformed checks.
