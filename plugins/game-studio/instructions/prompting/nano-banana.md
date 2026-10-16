Google Nano Banana 2.1 (`gemini-nano-banana-2.1`) is a fast Gemini image model. For game assets it is strongest at prompt-faithful renders, edits to existing art, consistent characters across references, and legible in-image text.

## Prompt structure

Write the prompt as one or two descriptive paragraphs, in this order:

1. An opening verb that names the operation ("Create", "Render", "Edit", "Combine").
2. Subject: what it is, its materials, colors, and defining features.
3. Action or pose.
4. Location, or a plain studio background for isolated assets.
5. Composition and camera: framing, angle, view (front, three-quarter, isometric).
6. Style: medium, rendering style, lighting, palette.

When references are attached, use: references, then each reference's role ("use Hero for the face and armor, Palette for the colors"), then the new scenario.

## Rules

- Write full sentences, not keyword lists.
- Use positive framing. Write "an empty stone floor", not "no props".
- Name materials exactly: "worn bronze plate armor etched with runes", not "armor".
- Quote any text the image should contain, and name its font style: the word "START" in a bold pixel font.
- For edits, say what changes and what stays. End with "Keep everything else exactly the same."
- Refer to attached images by canvas name or position. The app appends a numbered key that maps positions to names. Do not write that key yourself.
- Use up to 14 references. Only 4 characters and 10 objects keep high fidelity.
- Transparency is not guaranteed. For cutout assets, ask for a flat, solid, evenly lit background, such as plain white.

## The app controls these settings

Do not mention any of the following in the prompt:

- aspect ratio
- resolution (1K/2K/4K) or pixel size
- output count
- model name

## Example

Create a game-ready item icon of a frost-rune longsword with a pale blue crystal blade and silver crossguard, floating diagonally at a three-quarter view, centered on a flat solid white background, rendered as a crisp hand-painted fantasy RPG icon with soft rim lighting and a cool cyan palette.
