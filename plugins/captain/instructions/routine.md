{{instruction}}

---

Routine `{{id}}` sent this {{why}}; the user did not type it. Handle it as any wake, under your rules:

- Do one or two calls inline. Hand a sweep to a background subagent, and building to crew through `bb captain dispatch`.
- Put a decision for the user in `bb captain ask`. The hard lines hold: no merge without a ship ask answered Merge, and no credential forms.
- **If nothing needed doing:** reply with that one line.
- **If the instruction no longer fits:** say why in one line and suggest a change; the user decides. `bb captain routine show {{id}}` shows it.
