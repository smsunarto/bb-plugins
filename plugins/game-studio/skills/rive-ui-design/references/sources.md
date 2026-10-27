# Rive UI sources and decision notes

Researched 2026-10-26. These are primary vendor and game-accessibility sources.
The skill combines their recommendations into a production review workflow;
its device matrix and interruption scenarios are verification practices, not
claims that a vendor certifies a file or that every studio uses one process.
Check the installed runtime and refresh relevant pages before relying on a
version-sensitive feature. Platform guidance is not interchangeable across units.

## Rive authoring and runtime

- [Layouts overview](https://rive.app/docs/editor/layouts/layouts-overview):
  responsive rows, columns, grids, stacks, nested sizing, and Layout participation.
  Layouts position other Layouts; loose objects need deliberate structure.
- [Web layout and fit modes](https://rive.app/docs/runtimes/web/layouts):
  distinguishes responsive `Layout` from scaling/cropping modes and covers canvas
  size, drawing-surface density, and layout scale. Its API names are Web-specific;
  look up the equivalent in the consuming runtime before implementation.
- [Transitions](https://rive.app/docs/editor/state-machine/transitions):
  conditions, Exit Time, interruption during a transition, interpolation, and
  start/end actions. Use these controls to make interruption behavior explicit.
- [State-machine layers](https://rive.app/docs/editor/state-machine/layers):
  lower layers take priority when multiple layers animate the same property.
- [Listeners](https://rive.app/docs/editor/state-machine/listeners):
  hit targets, event propagation, and interaction types. Pointer Exit can be
  missed when leaving the render surface; test cancellation in the host too.
- [Data binding](https://rive.app/docs/runtimes/data-binding) and
  [legacy Rive Events](https://rive.app/docs/runtimes/rive-events):
  current guidance favors data binding for communication. Inspect installed
  support and preserve existing contracts when migration is outside scope.
- [Unity best practices](https://rive.app/docs/game-runtimes/unity/best-practices):
  panel/render-texture costs, composing larger UI sections, lists, file loading
  tradeoffs, shared assets, and disabling unused widgets. Profile the actual
  project before changing composition or resource quality.

## Mobile interaction and game accessibility

- [Apple: Design advanced games for Apple platforms](https://developer.apple.com/videos/play/wwdc2024/10085/):
  aim for 17 pt body text and 44 × 44 pt tap targets on iPhone/iPad; favor the
  recommended defaults over smaller minimums. Use scrolling instead of shrinking
  dense interfaces, and provide visible press feedback for touch controls.
- [Android: Make apps more accessible](https://developer.android.com/guide/topics/ui/accessibility/apps):
  recommends 48 × 48 dp touch areas. Text contrast is 4.5:1 below 18 sp regular
  or 14 sp bold, and 3:1 at or above those sizes. These size thresholds use sp,
  not raw export pixels or artboard units.
- [Google: Playables design best practices](https://developers.google.com/youtube/gaming/playables/certification/best_practices_design):
  cross-device scaling, text readability, 48 dp targets with 8 dp separation,
  button hierarchy, and distinct interaction states. These are useful mobile-game
  recommendations; platform-specific certification applies only where relevant.
- [Xbox Accessibility Guideline 101: Text display](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/101):
  measures rendered text body height, accounts for device density/viewing context,
  and recommends scaling to 200% without lost content or functionality. Its pixel
  tables are not nominal font sizes; measure the displayed glyphs and target device.
- [XAG 102: Contrast](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/102):
  assess UI over changing gameplay backgrounds and provide contrast options.
  Uses 4.5:1 for standard-sized informative text/visual elements and 3:1 for
  large-scale elements; inactive-element text also has a 3:1 recommendation.
- [WCAG 2.2: Non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html):
  3:1 for visual information needed to identify controls, their states, and
  meaningful graphics against adjacent colors. XAG's game-specific targets can
  be stricter; name the adopted criteria instead of treating them as identical.
- [XAG 112: UI navigation](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/112):
  consistent controls, logical focus movement, and accessible navigation paths.
- [XAG 117: Visual distractions](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/117):
  let players reduce or stop distracting movement, blinking, and auto-updating
  information. Keep reduced-motion behavior functional and inspect moving
  backgrounds behind stationary text.

The skill uses platform touch recommendations as its default acceptance targets,
not a claim of universal legal minima. A project-specific exception needs the
user's or designated project owner's recorded approval, rationale, and scoped
evidence. Screenshots and spot checks alone do
not establish complete accessibility or photosensitivity compliance.
