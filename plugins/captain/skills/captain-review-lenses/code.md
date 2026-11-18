# Lens: Code

Check the change for reuse, simplicity and the repo's own rules.

- Read the repo's `AGENTS.md` and any rules the brief names, and check the diff against each rule that applies.
- Find code that duplicates an existing helper, component or SDK API, and name what to reuse.
- Find layers, wrappers or state that the change could drop without losing behavior.
- Flag tests that would still pass with the behavior broken, or fail on a pure refactor.
- Report each finding with the file and line, the rule or the existing code it should use, and the smaller form.
