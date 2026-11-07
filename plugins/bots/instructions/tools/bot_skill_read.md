List or read this bot's own skills: reusable procedures it keeps in its home project, private to this bot.

USE WHEN

- A task may match one of your skills and this conversation runs outside your home project, where they do not load natively.
- You are about to change a skill with bot_skill_update and need its current content and sha256.
- The user asks which skills you have.

INPUTS
Omit name to list every skill with its description. Pass name to read that skill's complete SKILL.md.

RETURNS
Without name: `{ skills: [{ name, description }] }`, empty until the first skill is saved. With name: `{ name, content, sha256 }`. Follow the content as you would a loaded skill, and pass sha256 to bot_skill_update to replace it.
