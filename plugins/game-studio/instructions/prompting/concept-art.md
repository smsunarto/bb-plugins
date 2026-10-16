Midjourney V8.2 (the current default, run through the local Midjourney CLI, four images per job) is best for fast, stylish exploration of game concept art: moods, environments, character silhouettes, and key art.

## Prompt structure

Write a short descriptive phrase or sentence, in this order:

1. Medium or style ("painterly concept art", "isometric pixel art").
2. Subject, with an exact count ("three goblin scouts", not "goblins").
3. Key details: costume, materials, props.
4. Environment.
5. Lighting and color.
6. Mood.
7. Composition or view ("full-body turnaround", "wide establishing shot").

## Rules

- Keep it short. Long instructions and lists confuse Midjourney.
- Describe the image. Do not give commands: "colored pencil illustration of orange poppies", not "draw me poppies".
- Prefer precise words ("towering", "rusted") over vague ones ("big", "old").
- Name only what should appear. Writing "no swords" tends to add swords.
- Put rendered text in double quotes, such as a sign reading "TAVERN". Keep it short and use it sparingly.
- Attached references act as image prompts. They inspire the result; Midjourney does not copy them. Describe the whole final image, not edits to the reference: "detailed portrait of a dog", not "this image but a dog".
- Write no parameters. The app rejects any prompt with a `--` flag (`--s`, `--c`, `--no`, `--raw`, `--sref`, `--tile`, `--iw`, and so on) or `{a,b}` permutations. Express style, variety, and exclusions in words.
- Never write `::` weights, `--oref`, or `--cref`. V8.x does not support multi-prompts or Omni Reference.

## The app controls these settings

Do not mention any of the following in the prompt:

- aspect ratio (`--ar`)
- version (`--v`, `--niji`)
- speed (`--fast`, `--relax`, `--turbo`)
- batch size, repeats, draft, HD/SD
- reference attachment

## Example

painterly fantasy concept art of a moss-covered dwarven forge carved into a cliffside, molten orange light spilling from stone doorways, two dwarven smiths hauling an anvil, misty blue dusk, wide establishing shot
