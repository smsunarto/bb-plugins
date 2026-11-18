# Lens: Performance

Check the change against the repo's performance rules; in `bb-plugins`, the Performance section of `AGENTS.md`.

- Stylesheet weight: new CSS, re-emitted host utilities, or generated files in the plugin root.
- Universal-bucket selectors: `space-*`, `divide-*`, or selectors ending in `:is()` or `:not()`.
- Forced layout: geometry reads during mount or navigation, or in a mutation callback.
- Fan-out: a default path that queries every host or project and waits for all of them.
- Unstable identities, remount churn, invisible registered slots, heavy payloads, and new bundle weight.
- Report each finding with the file and line, the rule it breaks, and the cheaper form. Measure when the claim depends on a number.
