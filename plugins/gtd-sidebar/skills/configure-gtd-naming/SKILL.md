---
name: configure-gtd-naming
description: Configure GTD Sidebar title rules from the project when the user asks to set up or revise GTD_NAMING.md.
disable-model-invocation: true
---

# Configure GTD naming

Write `.agents/GTD_NAMING.md` in the active project workspace. Run this setup
only on the user's request.

1. Read the existing `.agents/GTD_NAMING.md`. Inspect the project README,
   manifests, and top-level source directories. Stop once each proposed naming
   rule has a concrete project area behind it.
2. Choose a small set of recognizable product areas. Use `[Area] Task` only when
   scopes distinguish meaningful areas in this project. For a single-purpose
   project, prefer plain titles. Preserve the user's existing naming preferences
   unless they asked to change them.
3. Create or update `.agents/GTD_NAMING.md` directly. Keep the entire file at most
   500 characters, including newlines, so every rule reaches the title model.
   For scoped projects, map work to exact prefixes, when to combine them, and
   when to use a plain title. Otherwise write plain-title rules. Keep project
   names out of prefixes and avoid repeating a prefix in the task text. Omit
   headings and explanatory prose.
4. Read back the file, verify the character budget, and check the rules against
   one representative task per area and one task outside those areas. Each task
   must have an unambiguous format. Report the file link and two example titles.

For a project with distinct billing and account areas, a compact result could be:

```md
Use [Billing] for invoices, payments, and tax. Use [Accounts] for profiles and login.
Use [Billing + Accounts] for work spanning both. Otherwise use a plain title.
Keep prefixes out of the task text.
```

Existing thread titles remain stable. The rules apply when GTD generates a new
title or the user selects Generate thread name.
