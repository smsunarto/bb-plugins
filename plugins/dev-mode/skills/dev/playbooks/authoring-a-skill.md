# Authoring a skill

Writing or editing a SKILL.md.

What tends to work:

1. Use the installed skill-authoring skill, if there is one.
2. Keep only prose that changes a decision; when in doubt, delete. Say what to do and skip the reason unless the rule is confusing without one. Match the tone to the scope.
3. Point at structural sources (types, READMEs, config) instead of restating them (`encode-lessons-in-structure`), and refer to other skills by name or path rather than copying them.
4. Check that the frontmatter has `name` and `description`, referenced files exist, and links to other skills resolve. Add test cases when the skill's behavior is structural; skip them when it's subjective.
5. A workflow you keep hitting that no skill captures is a candidate for a new skill.

A good reply summarizes the skill, its key design decisions, and the validation notes.
