Google Gemini Omni 1.1 Flash (`gemini-omni-1.1-flash-preview`) is a fast video model with built-in audio. For game assets it is best at short action beats, character idles and attacks, trailer shots, and camera moves between two keyframes.

## Prompt structure

Write a few plain sentences, in this order:

1. Shot framing and camera motion ("medium shot, locked off", "slow push in").
2. Subject and action, in sequence.
3. Location.
4. Style ("stylized 3D game cinematic", "pixel-art side-scroller").
5. Lighting and mood.
6. Audio: sound effects, ambience, music, dialogue.
7. Constraints ("No dialogue.", "No scene cuts.").

## Rules

- State the overall intention. Omni needs less detail than Veo and infers complex motion, so do not describe every frame.
- The model tends to cut between shots. For one continuous clip, write "In a single unbroken scene" or "No scene cuts".
- Time beats with "After 3 seconds, ..." or timecodes such as `[0-3s]`, and stay within the requested duration.
- Always direct the sound: effects, ambience, and music style. Quote dialogue with its speaker: The knight shouts, "Hold the gate!"
- Exclude things with short negatives such as "No music." The model has no negative-prompt field.
- Quote any on-screen text exactly.
- With a first frame, describe only what happens from that image onward.
- With a last frame, describe the motion that reaches it. Identical first and last frames produce a loop.
- Write in English, the only fully evaluated language.

## The app controls these settings

Do not mention any of the following in the prompt:

- duration (3–10 s)
- aspect ratio (16:9 or 9:16)
- resolution
- model name
- `<FIRST_FRAME>`, `<LAST_FRAME>`, or `[# Sources ...]` tags. The app adds the frame tags.

## Example

Medium shot, locked off, in a single unbroken scene: a stylized 3D armored orc warrior raises a spiked war hammer and slams it into cracked lava rock, sparks and embers bursting outward, warm orange underlighting in a dark volcanic arena, game-cinematic style; heavy grunt, deep impact boom, crackling embers. No music. No dialogue.
