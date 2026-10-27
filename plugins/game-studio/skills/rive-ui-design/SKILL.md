---
name: rive-ui-design
description: Design, revise, or review Rive game menus, HUDs, and interactive components. Check rendered layout, responsive behavior, mobile readability and touch targets, and motion interruptions in the target runtime.
---

# Rive UI design

Deliver UI that players can read, operate, and follow at its actual display size.
Own the correction loop: inspect the rendered interface, reproduce defects,
repair them within scope, and inspect fresh evidence. A valid export, plausible
state graph, or screenshot at one size does not establish readiness.

Use the relevant steps for the requested scope. A design-only task delivers a
design and verification plan; an asset-only task can verify the Rive preview but
leaves engine integration unverified. A read-only review reports findings without
editing. Preserve the user's art direction and existing interaction contracts.

## Establish the screen contract

1. Identify the source Rive file/revision, exported `.riv`, artboards, state
   machines, view models, fonts/images, and consuming screen. Inspect the actual
   source and current render before editing. Preserve public names, types,
   instance defaults, and bindings used by code or other artboards unless their
   migration is part of the task. Verify source-to-export fidelity before using
   a downloaded or converted project as the editable source of truth.
2. Identify target platforms, orientations, input methods, smallest supported
   display, aspect-ratio extremes, safe areas, text/UI scale settings, locales,
   and expected viewing distance. Inspect installed Rive/engine versions and
   feature support before choosing layout, data binding, or accessibility APIs.
   Use the project's supported devices; otherwise state provisional targets.
3. Define the player task, primary action, information hierarchy, component
   inventory, and relevant states: default, focused, hovered, pressed, selected,
   disabled, loading, empty, error, success, opening, and closing. Include
   simultaneous surfaces such as HUD, tooltip, toast, modal, and keyboard.
4. For each component, record its alignment anchor, spacing/padding, text behavior,
   hit area, responsive rule, and motion/interaction behavior. Identify intended
   overlaps by component pair and state, with z-order and input ownership; an
   unexplained intersection is a defect. Distinguish decoration from content
   and controls that must remain visible.

Keep these decisions and check results in the existing design document, task
notes, or response; create a separate tracked document only when requested.
For a Game Studio project, read `game_studio_canvas_context` and relevant saved
documents first, and use its revision-aware tools for studio changes. Standalone
Rive work starts from its own project. Follow `unity-editors` before operating a
Unity Editor and the installed `unity:unity-cli` guidance for Editor actions.

## Compose the interface

Build a static layout with real representative content before polishing motion.
Reuse the game's typography, spacing, colors, iconography, and component states.
Keep the primary action and critical game information visually distinct; reserve
space for HUD elements, subtitles, and system overlays that can coexist.

- Use Rive Layouts for content-driven sizing and reflow where the target runtime
  supports them. Rows/columns need participating Layout children; putting loose
  objects in a parent does not automatically arrange them. Separate layout-owned
  positioning from decorative animated offsets so two systems do not fight.
- Choose the runtime fit, alignment, and scale deliberately. Responsive artboards
  need the runtime's layout mode and actual container size updates. `Contain`
  scales a fixed composition; it does not reflow it. `Cover` may crop and `Fill`
  may distort. Inspect any cropping against the critical-content contract.
- At narrow sizes, reflow, wrap, stack, simplify secondary detail, or provide
  deliberate scrolling. Preserve readable type and usable controls instead of
  shrinking the whole screen. Keep primary actions reachable with safe-area and
  on-screen-keyboard insets. Verify scroll clipping and access to the final item.
- Treat text as variable content. Exercise long translations, long player names,
  large numbers, missing values, multiline errors, and supported scripts/RTL.
  Check font coverage, shaping, baselines, line height, truncation, and fallback
  fonts in the export/runtime. Keep essential instructions and actions readable;
  provide a way to reveal content when intentional truncation is necessary.
- For mobile, start from at least **44 × 44 pt on iOS/iPadOS** and **48 × 48 dp
  on Android** for effective touch areas. These are this workflow's default
  acceptance targets, based on platform recommendations. Measure after all
  runtime transforms, in logical device units, using verified display metrics.
  Artboard units and screenshot pixels alone do not prove physical usability.
  Expanded invisible targets need separation and correct event ownership too.
- Use platform-appropriate type sizes and inspect at native viewing size. Apple's
  game guidance recommends aiming for 17 pt or larger for iPhone/iPad body text.
  Do not use a platform's absolute minimum as the default for important copy.
  Reflow around the player's text/UI scale settings; test up to 200% text where
  supported or when adopting the XAG accessibility target.
- Measure contrast on the composited background, including bright, dark, and busy
  gameplay: use 4.5:1 for ordinary text and 3:1 for large text under the relevant
  platform definition, plus 3:1 for essential non-text UI boundaries/indicators.
  Apply stricter selected game/platform criteria where they differ, such as XAG
  102's 4.5:1 target for standard-sized informative visual elements.
  Pair color with a label, shape, or icon for meaning. Use a backing plate or
  outline where the scene cannot reliably supply contrast.
- For supported input modes, provide visible focus, predictable navigation,
  press feedback, consistent confirm/back behavior, and a usable route without
  hover. Keep semantic labels, values, disabled states, and reading order in the
  host accessibility integration where the Rive renderer does not provide them;
  verify actual platform support rather than assuming a canvas is accessible.

The static pass is complete only when the whole composition and every component
have been visually inspected at the supported size extremes with stress content.
Use [verification](references/verification.md) to select the remaining matrix.

## Design motion and state ownership

Define what each motion communicates: feedback, hierarchy, navigation, change,
or reward. Use consistent easing and timing; keep common actions responsive and
avoid making players wait for decoration. Specify interrupted behavior explicitly:
reverse, retarget, finish, or ignore according to the component's contract.

Map each interaction to its authoritative owner and observable result. Game code
owns gameplay facts and command validity; Rive presents them and reports intent.
Prefer data binding for new integrations when the installed runtime supports it.
Preserve working legacy inputs/events unless migration is within scope.

- Inspect every relevant transition's conditions, order/priority, duration,
  Exit Time, Allow exit during transition, and any start/end actions. Check Any
  State paths and unconditional cycles. Ensure back/cancel has a deliberate
  response during entry, exit, and loading.
- Inspect properties keyed by multiple animations or state-machine layers.
  Establish intentional ownership/blending; lower layers in Rive's list take
  priority when animating the same property. Check whether hover, focus, selected,
  and disabled effects can override one another unexpectedly.
- Keep persistent state separate from one-shot actions. One intended activation
  produces one command, sound, haptic, or completion notification as specified.
  Check pointer-down/up/click listeners and code callbacks for duplicate delivery.
  Do not infer callback timing from the graph; observe the installed runtime.
- Associate asynchronous results and completion callbacks with the active screen
  or request. A late result from a closed screen must not alter a reopened one.
  End subscriptions and input ownership with their screen lifecycle. Verify
  inactive or visually hidden controls cannot capture input. Keep intentional
  transparent hit targets and modal input blockers in the interaction contract.
  Suspend unused updates/drawing after any required exit animation completes.
- Provide reduced-motion behavior for decorative movement, large travel,
  parallax, shaking, and perpetual effects within the product's accessibility
  scope. Preserve feedback and completion semantics when motion is shortened
  or removed. Check loop seams, flicker, distracting repeats, and flash risk;
  apparent smoothness is not a photosensitivity certification.

Run the interruption scenarios in [verification](references/verification.md).
Review a recording at normal speed for feel and frame-step the failure boundaries.
Judge alignment, overlap, clipping, and hit areas during motion as well as at
rest. A screenshot cannot pass a motion check; a graph review cannot prove
absence of runtime races.

## Integrate, verify, and correct

Exercise the actual exported `.riv` in its consuming runtime with real input
routing and representative data. Check asset loading, first frame, font fidelity,
safe-area handling, UI scale, focus, hit testing, and resize without state resets.
For Unity, verify through the actual panel/widget/raycaster and rendered output;
setting a view-model value directly does not prove that a player can press it.

Use the project's frame-time and memory budgets on representative hardware.
Profile open/close, busy lists, transitions, and long idle periods. For Unity,
consider shared panels and larger composed Rive screens to reduce render-texture
overhead; choose file boundaries for loading and ownership needs. Reuse assets
where appropriate and verify hidden screens stop doing unnecessary work. Any
resource reduction needs fresh visual checks at the largest rendered size.

For each check, record **pass**, **fail**, **blocked**, or **not applicable** with
the export revision/hash, runtime, device/container size, scale, state/scenario,
and evidence. Explain exclusions. Inspect screenshots yourself at native size and
zoom for defects; automated bounds and contrast checks supplement visual review.
Fix layout/readability/input failures before polish, then rerun affected scenarios
and inspect the complete screen. Changes invalidate dependent earlier evidence.

The ready gate requires current evidence for every in-scope component and required
layout, mobile usability, input, motion, and runtime scenario, with no unintended
overflow, misalignment, overlap, or observed interaction race. Missing device or
runtime coverage stays blocked/unverified. Scope a motion verdict to the scenarios
actually run; do not claim a finite test proves the absence of every possible race.
Only the user or designated project owner can approve a readiness exception.
Record that approval, the named criterion, and its evidence; label the result
ready with deviations while retaining the criterion's actual status. Without
that approval, a failed or blocked criterion keeps the result incomplete.

Hand off the source/export identities, concise change list, screenshots at key
sizes, reviewed interaction recording (use `media:demo` when available), verification
results, known limits, and commit status. Distinguish verified behavior from human
art approval. Use [sources](references/sources.md) to check platform thresholds or
runtime-specific decisions; refresh the relevant official page when support changes.
