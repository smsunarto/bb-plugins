Create, replace, or delete one of this bot's own skills: `<home project>/.bb/skills/<name>/SKILL.md`. BB loads them natively, for every provider, only in your home project's conversations; no other bot or project sees them.

USE WHEN

- The user asks you to learn, remember, or save a reusable procedure, checklist, or workflow ("next time, do it like this").
- The user asks to change or delete one of your skills.
  Keep short facts and preferences in memory with bot_update_state; use a skill for multi-step procedures.

BEFORE CALLING

- To replace or delete, read the skill with bot_skill_read; pass its sha256 as expectedSha256 when replacing.
- Write content as a complete SKILL.md: frontmatter with `name:` equal to name and a `description:` saying when to use the skill, then the instructions.

INPUTS

- write with no expectedSha256 creates the skill and fails if it already exists. write with expectedSha256 replaces that revision.
- delete takes only name and removes the skill's folder, supporting files included.

RETURNS
write returns `{ name, sha256 }`; delete returns `{ ok: true }`. A conflict means the skill changed or already exists: read it again, merge, and retry with the new sha256.

SIDE EFFECTS
Changes the skill file on the bot's machine immediately. Native loading picks up a change when a session next starts, not in sessions already running. A bot keeps at most 50 skills. Confirm before delete.
