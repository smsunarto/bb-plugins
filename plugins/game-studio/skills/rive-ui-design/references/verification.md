# Rive UI verification

Build a matrix from the screen contract. Cover each relevant row below; combine
independent variations where useful rather than blindly multiplying every axis.
Exercise high-risk combinations explicitly: smallest safe area + longest label +
largest supported text, and an active transition + resize + updated game data.

## Layout and content matrix

| Axis              | Coverage                                                                                                                             | Inspect                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Container         | Smallest supported phone, tall/narrow phone, tablet, desktop, widest supported aspect ratio; portrait/landscape only where supported | Insets, anchored HUD, reachable actions, content density, reflow rather than distortion                       |
| Continuous resize | Sweep between sizes, pause near layout thresholds, rotate during interaction; resize the actual UI container                         | No transient clipping/overlap, state reset, lost focus, stale hit areas, or jump between incompatible layouts |
| Height/insets     | Short window, notch/cutout, rounded corners, home indicator, keyboard and system overlays                                            | Primary controls and focused fields stay visible or can be scrolled into view                                 |
| Density/scale     | Target display density and render-target resolution; default and largest supported UI/text settings                                  | Correct logical size, sharp text and raster assets, stable stroke weight, complete text                       |
| Content           | Empty, typical, maximum count; long labels/names, wide numbers, errors; supported languages and RTL                                  | Baselines, wrapping, padding, truncation policy, glyphs, list growth, correct directional order               |
| Coexisting UI     | HUD + subtitles + toast, modal + backdrop, tooltip + focus, virtual controls as applicable                                           | Intentional z-order, no obscured essential information, no ambiguous input ownership                          |

If supported device sizes are unknown, use provisional layout probes such as
360 × 800 and 800 × 360, 768 × 1024, 1280 × 720, and 2560 × 1080 in the harness's
logical viewport units. These are exploratory examples, not a shipping device
list. Report their units and replace them with product targets. A 1920-pixel
desktop screenshot is not a phone readability check.

Inspect the whole composition first, then every component: bounding box, parent
padding, row/column gap, baseline and optical alignment, icon-label relationship,
stroke/shadow extents, clip/mask, neighboring components, and touch area. Check
alignment against the intended anchor rather than assuming every element should
be centered. List intended overlaps with their permitted states and regions.

### Touch and legibility

- Measure each actionable target in final display coordinates and convert with
  the device's verified logical scale/density. Keep physical pixels, CSS pixels,
  iOS points, Android dp/sp, and Rive units distinct. Device pixel ratio alone
  does not establish a physical millimeter size. In an engine, verify its canvas
  scaling and safe-area mapping before reporting platform-unit measurements.
- Use the skill's 44 pt / 48 dp targets. Leave room between adjacent hit areas;
  Google's game guidance recommends 8 dp spacing on Android. Enlarge small icons'
  hit regions without stealing adjacent controls' input. Probe center, edges,
  corners, inter-control gaps, and the edge nearest a screen gesture region.
- Perform real touch tests on a representative small device when available:
  thumb reach, finger occlusion, repeated presses, scrolling near buttons,
  and dragging off a control. Simulator/mouse success leaves touch ergonomics
  unverified. Inspect press feedback while the finger covers the icon.
- Measure contrast against the final blended background, including motion and
  enabled/selected/focused states. Evaluate important disabled-state explanations
  for legibility too. Verify meaning survives without color and that enlarging
  text does not hide actions or require two-axis scrolling.
- For controller/keyboard support, test every reachable control, focus visibility,
  navigation after reflow/list updates, modal focus containment, back/cancel, and
  focus restoration. Test screen narration/semantics through supported platform
  tooling when that is in scope; visual text alone is insufficient evidence.

## Motion and interaction matrix

For each animated interactive component, name the expected final state and
permitted side effects before running these applicable scenarios. Use real
pointer/touch/controller routing, then inspect callback/state logs as needed.
Replay interruptions near the start, middle, and end of transitions.

| Scenario               | Required observations                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rapid activation       | Repeated tap/click/confirm and simultaneous input sources obey the action policy; no duplicate purchase, submit, sound, navigation, or completion                      |
| Reverse mid-transition | Open → close → open; hover → press → leave; selected → disabled; final appearance and interactivity agree with latest valid intent                                     |
| Pointer cancellation   | Press then drag outside/release, leave the render surface, lose focus, receive touch cancel, or scroll; no stuck pressed state or accidental click                     |
| Lifecycle              | Close/reopen, remove/remount a list item, navigate away, reload the asset; no stale listeners, ghost hit areas, old selection, or callbacks into disposed instances    |
| Async timing           | Immediate/slow response, failure → retry, data during entry/exit, old response after close/reopen; only the current operation affects state                            |
| Focus/input ownership  | Modal appears over a held control; back during loading/exit; switch mouse/controller/touch; no click-through or activation behind the modal                            |
| Timing stress          | Target frame rates, a throttled/low-frame-rate run, long frame, pause/background/resume; no skipped necessary outcome, doubled completion, or jump into unusable state |
| Dynamic content        | List insertion/removal, count/label update, resize/rotation during animation; layout, hit testing, and focus agree with what is rendered                               |
| Reduced motion         | Trigger the same flow with shortened/disabled decorative animation; state completion, focus restoration, and command counts remain correct                             |
| Idle/loop              | Watch several complete cycles and leave/reenter; seamless intended loop, no accumulating transforms, distracting flash, or hidden animation work                       |

Look for competing writers when a visual snaps or flickers: two state-machine
layers, multiple transitions whose conditions are true together, nested component
state, layout plus animated positioning, or code plus a keyed property. Check
actual transition ordering and mixing in the installed runtime. Arbitrary delays
can hide the symptom; fix the responsible ownership or transition rule.

Observe whether callbacks run inside the runtime's advance/input/render path.
Follow that runtime's supported safe mutation/disposal timing. Guard the concrete
failure, such as an old close callback hiding a new screen; avoid blanket queues
or synchronization machinery without an observed need.

Review normal-speed video for pacing, clarity, easing, and perceived response.
Frame-step interruptions, motion extrema, first/last frames, and loop seams for
one-frame overlap, clipping, snaps, flicker, and input/visual mismatch. Confirm
intentional off-screen entrances do not strand content or expose hit regions
before the control should become interactive.

## Runtime and evidence

Load the exact final export in the target runtime. Verify loading/error fallback,
initial bindings and first advance, fonts/images, pointer coordinate conversion,
actual rendering, event count, and teardown/reuse. Keep editor-preview, engine,
simulator, and physical-device results separate. Profile the finished UI against
the project's budgets, including cold load, peak transitions, dynamic lists,
render-texture memory, and inactive screens. Do not trade sharpness or usability
for an unmeasured optimization.

Use a compact result row per component/scenario: requirement → environment/state
→ observed result → pass/fail/blocked/not applicable → evidence → next correction.
Link screenshots and a reviewed recording with export identity, viewport/device,
scale, locale, input method, and relevant timestamps. Keep evidence in the task's
existing artifact location and verify it remains readable at handoff. Recheck
affected rows after any export, binding, layout, animation, or host-code change.
