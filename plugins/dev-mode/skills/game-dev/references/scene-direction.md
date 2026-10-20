# Resolve scene direction and review views

Use this reference for substantial environment design or game UI changes. Scale
it to the requested work. A focused correction does not require redesigning the
whole scene. Follow `SKILL.md`'s worker model rules for visual design and acceptance.

## Turn the brief into visible decisions

Separate requested requirements from inferred choices. Preserve accepted direction
and the existing engine. Keep the decisions in the thread or an existing design
document; create a separate design artifact only when requested or needed by the
project. Record substantive deviations rather than silently dropping requirements.

Identify the important locations, travel paths, and focal subjects. Resolve the
relevant dimensions of each before committing production assets or visual code:

| Dimension   | Decision to resolve                                                                  |
| ----------- | ------------------------------------------------------------------------------------ |
| Space       | Position, facing, size, neighboring elements, and reachable connections              |
| Shape       | Silhouette, proportions, component structure, and physical connections               |
| Use         | Activity, supporting objects, and details whose placement follows that activity      |
| Surface     | Material boundaries, texture scale, color, wear, and intentional variation           |
| Atmosphere  | Illumination, depth, weather, and motion that support the intended mood              |
| Player view | Arrival framing, travel-height views, discoveries along routes, and close inspection |

Connect large-scale layout to focal subjects and nearby detail. Use deliberate
focal hierarchy and quieter areas instead of distributing detail evenly. Make
navigation, obstacles, ground contact, and visibility agree with the intended play.

Before visual implementation, check whether layout, focal structure, material
relationships, or camera composition still depend on unmade design choices.
Resolve those choices with the design owner. Technical scaffolding can continue
while design is being settled. Assess completeness by observable decisions, not
document length, prop counts, or generic mood adjectives.

## Define how the result will be inspected

Choose views that establish the requested requirements. Describe what each must
show before implementation, then inspect actual runtime captures during
[Game playtesting](game-playtest.md). These categories guide coverage; they are
not a screenshot quota or a requirement to inspect unrelated scenes.

| View                  | Evidence to look for                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Arrival or overview   | Recognizable theme, scale, connected locations, and focal hierarchy                            |
| Travel path           | Player movement, reachability, grounding, obstacles, and discoveries along the route           |
| Focal subject nearby  | Distinctive silhouette, construction, material differences, and required details               |
| Supporting detail     | Contextual props, surface treatment, and traces of activity visible at intended scale          |
| HUD and overlays      | Legibility during play, usable controls, and unobstructed action with overlays open and closed |
| Other supported sizes | Framing, safe areas, and control placement at relevant aspect ratios or device sizes           |

Walk required routes with real input. Camera positioning can help inspect detail
but does not prove traversal. Tie each observation to its design requirement,
correct the specific defect, and recheck the affected view. Existing visual and
motion acceptance rules still apply. Report uncovered views as unverified.

## Keep the playfield readable

Keep information needed for immediate decisions visible. Put infrequent actions
and secondary information in contextual or pause surfaces. Protect the primary
action area from persistent instruction panels and competing button strips.

Carry the game's visual language into controls. Use short labels for unfamiliar
icons and check readability over actual moving gameplay. Keep dynamic text, hit
areas, and interaction states in the existing UI system. Use art for appearance
without baking changing values or interaction logic into images.

Gate gameplay and camera input while modal surfaces own focus. Check pause,
resume, and interrupted transitions. When touch is supported, inspect target size,
safe areas, and control placement at the smallest supported viewport.

These design and inspection criteria draw on OhMyGame's
[world expansion](https://github.com/WhiteTowerAI/ohmygame/blob/7e931f07986fa493d5117da16ca4122b8ffa6989/plugins/threejs-world/skills/threejs-world/references/world-expansion.md),
[world validation](https://github.com/WhiteTowerAI/ohmygame/blob/7e931f07986fa493d5117da16ca4122b8ffa6989/plugins/threejs-world/skills/threejs-world/references/validation.md),
and [game UI guidance](https://github.com/WhiteTowerAI/ohmygame/blob/7e931f07986fa493d5117da16ca4122b8ffa6989/plugins/web-game-studio/skills/game-ui-frontend/SKILL.md).
