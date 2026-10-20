---
name: game-dev
description: "Use when designing, building, improving, debugging, or reviewing games and game features, including gameplay, levels, environments, game UI/HUD, animation, and game assets. Applies to new and existing projects in Unity, Unreal, Godot, or custom/web engines, even when the request names only a scene or feature. Guides scene direction, asset production and integration, and playtesting with Scott's preferred tools."
---

# Game development workflow

Use this skill for game work even when the request does not say "game development"
or invoke the skill by name. Match the workflow to the requested scope: a focused
bug fix, review, or design discussion uses only the relevant sections. Engine
installation, CI, and general infrastructure work do not trigger this skill solely
because they belong to a game repository.

When the requested feature needs new or changed assets, inventory them, then
develop code while BB subthreads create or tweak the missing assets. Use functional
placeholders that satisfy the same contract as the final assets, so integration
replaces assets without rewriting their consumers.

For substantial environment or game UI work, read
[Scene direction and review views](references/scene-direction.md) before specifying
production assets. Keep focused changes within the existing design and engine.
Discussion, design-only, and graybox requests keep their requested delivery scope.

Read [Game playtesting](references/game-playtest.md) when planning verification
and checking integrated gameplay. Use the project's existing runtime and QA tools.

## Inventory, placeholders, and parallel work

Read [Parallel asset workflow](references/parallel-work.md) before planning a
game feature or coordinating asset work. Apply this sequence:

1. Inspect the required assets and classify each as **reuse**, **tweak**, or
   **create**. Record its source, consumer, dependencies, and acceptance criteria.
   Check technical fit yourself. Send visual or motion candidate previews to
   Opus for suitability and reuse or tweak decisions before finalizing that choice.
2. Define technical constraints and start any Opus design planning immediately.
   Freeze versioned asset contracts using its design decisions before production.
   Keep identifiers, references, and behavior compatible with the final assets.
   A completed placeholder is not a launch gate.
3. Recommend the runnable asset subthreads and the coordinator's next unblocked
   coding task. Launch work within the existing scope and budget.
4. Build functional placeholders and continue unblocked code and tests while
   workers produce assets. Avoid placeholder-only code paths. Start dependent
   work as its actual inputs become available.
5. Verify each delivered asset against its contract, replace its stable asset
   slot, and test the existing feature with the final asset. Capture the integrated
   visuals or motion for Opus acceptance when the feature involves design judgment.
   Track remaining placeholders until their replacements are integrated.

The coordinator owns code, the inventory, shared editor state, and integration.
Asset workers own separate staging outputs. Workers do not spawn more children;
they ask their coordinator to arrange any dependent work.

## Choose the worker model

Use **Opus 5.5 High** for work requiring visual, motion graphics, or design
judgment. This includes art direction, composition, UI layout, animation timing
and feel, 3D appearance, concept selection, and aesthetic acceptance. Use these
explicit BB execution flags:

```sh
--provider claude-code --model claude-opus-5-5 --reasoning-level high
```

A coordinator already running Opus 5.5 High can handle those decisions directly.
Otherwise, arrange a linked Opus child while continuing unblocked work. Workers
ask their coordinator to arrange this work rather than delegating again.
If Opus is unavailable, report the blocker rather than substituting another model.

**GPT Image 2 generation and edits are the sole exception:** use the Codex
child settings below, because that tool requires the Codex harness. A separate
visual or design acceptance still uses Opus 5.5 High whenever it involves
style, aesthetics, or motion feel.

**Audio workers, including music, SFX, narration, and dialogue, inherit the
primary coordinator's provider, model, and reasoning settings.** Explicitly
copy its current execution settings as described in the parallel workflow;
omitted spawn flags can select project defaults. Ordinary code and technical
integration remain with the coordinator, implementing Opus's approved design.

Worker selection does not change the asset tool: Opus uses Midjourney or Tripo
for the visual routes below; it does not replace their generation tools.

## Choose a production workflow

Read [Asset production recipes](references/asset-recipes.md) for the matching
task: characters and 3D props, 2D art, or UI and motion. The character recipe
explores a design in Midjourney, prepares consistent views with GPT Image 2,
and feeds accepted view files to Tripo while code and audio continue in parallel.
Reuse accepted inputs and skip stages that add no value to the requested asset.
Always use **P2 Clean Topology** for Tripo geometry. Never use text-to-model;
turn text briefs into approved Midjourney or GPT Image 2 references first.
P2 in our Studio wrapper produces geometry only. Prioritize visual quality:
silhouette, identity, proportions, materials, and gameplay-scale readability.
Review the solid mesh and wireframe, then select the strongest visual candidate
with a scoped Blender cleanup plan before separately authorized finishing.
Repairable topology defects are cleanup work, not a default reason to reject
or regenerate a visually strong candidate. Verify suitability for its intended
use after cleanup; raw generation need not be production-clean.
Read `tripo docs --topic quality` for reference and mesh acceptance checks.

Build fresh child briefs from [Prompt templates](references/asset-prompts.md).
Combine the shared handoff header with the relevant stage template, and fill
every field before sending it with `--prompt-file`. Templates guide production;
they do not authorize extra outputs, paid jobs, or changes to the asset contract.

## Choose the asset tool

Honor an explicit tool choice; otherwise use the routes below. Keep generation
within the requested deliverables, output count, and budget.

| Asset or priority                                              | Route                               | Start here                                                            |
| -------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| 3D model generation                                            | Our Tripo Studio CLI                | Read [Tripo](../tripo/SKILL.md), then run the wrapper's `docs --llm`. |
| Concept art or illustration; style and aesthetics matter most  | Our Midjourney CLI                  | Run `midjourney skills get core`.                                     |
| Precise image edits or prompt accuracy matters more than style | GPT Image 2 in a BB Codex subthread | Follow the image subthread instructions below.                        |
| Narration and spoken dialogue                                  | ElevenLabs CLI                      | Read `elevenlabs text-to-speech convert --help`.                      |
| SFX and non-speech audio                                       | ElevenLabs CLI                      | Read `elevenlabs text-to-sound-effects convert --help`.               |
| Music and BGM                                                  | Suno through browser use            | Open [Suno](https://suno.com) in the user's authenticated browser.    |

## Choose the image route

Default to Midjourney for visual exploration, mood, style, and aesthetic polish.
Use Fast generation by default; explicit speed requests override it.
Use GPT Image 2 when exact instructions dominate: changing one part while
preserving the rest, matching reference geometry, placing or counting objects,
rendering exact text, or keeping composition and identity consistent.
For a precise edit of Midjourney art, pass the selected image to the GPT route.

## GPT Image 2 through a Codex subthread

At coordinator level, delegate this route to a linked BB child, including when
the coordinator already runs Codex. A child already assigned this image task
executes it without further delegation. A worker needing this route within a
broader assignment asks its parent to arrange the image child.
Use `bb guide threads` for the current creation and coordination commands.
Resolve the current project and environment with `bb status --json`, then use
`bb thread spawn --parent-self` in that project and environment with these
explicit execution flags:

```sh
--provider codex --model gpt-6.1-sol --reasoning-level high
```

GPT-6.1 Sol runs the child; GPT Image 2 generates or edits the image. Pass the
self-contained child prompt using `--prompt-file` with a file or a quoted
heredoc (`--prompt-file - <<'PROMPT'`). This preserves backticks and `$()` in
the prompt instead of letting the shell execute them. Include:

- Use GPT Image 2 through the built-in `image_gen` tool. Read `imagegen` first.
  If that image model or tool is unavailable, report the blocker without
  silently changing the model or switching to a paid API script.
- Supply the asset brief, exact text, references, edit targets, and invariants.
  Attach input images with `--image` and give absolute paths for local inputs.
  Inspect local edit targets before editing; keep unchanged details explicit.
- Give ownership only of the assigned staging outputs, plus the authorized
  output count and budget. Final destinations are reference only. The parent
  verifies and copies selected outputs; the child never overwrites project assets.
- Name the parent coordinator. Do the assigned work without further delegation,
  respect other workers' files, and leave version-control operations to the parent.
- Inspect the result against the brief and invariants. Return saved paths and
  previews, the prompt used, and any remaining mismatch.

Verify the returned artifacts and integrate them into the requested project.
Child completion alone does not establish that the edit meets the brief.

## Audio routes

Use ElevenLabs narration with the requested script, voice, pronunciation, and
pacing. Use its sound-effects command for impacts, ambience, UI sounds, and
other SFX. Inspect the installed command's help for output and format options.

Use Suno's browser interface for music and BGM. Prefer the user's authenticated
Chrome session and load the matching browser skill. Describe scene, mood,
instruments, tempo, and energy; select instrumental for BGM unless vocals were
requested. Download the chosen track and check the actual audio, duration, and
loop transition when looping is required.

Workers save selected assets only in their assigned staging directory and report
their paths. The coordinator verifies and integrates them at the final destination.
