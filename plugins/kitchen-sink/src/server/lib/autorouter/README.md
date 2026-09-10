# Autorouter

The master switch and independent project/model switches live in `bb.settings`.
A per-composer pause button is blue when active and muted when paused. It is hidden
when the master switch is off or no routing applies. One Codex `gpt-5.6-luna`
completion with `medium` reasoning chooses the enabled dimensions. Kitchen Sink
uses the shared `@bb-plugins/codex-inference` host transport. Credentials stay on
the host. Inference has no tools, a strict JSON response schema, and a 20-second
deadline without retries.

Project routing compares explicit instructions first, then the editable index.
Uncertain project selection keeps the current project. Follow-ups keep their
project and provider. Astra can change its reasoning. Luna Max can escalate to
Astra, but no follow-up can route to Luna. Other models bypass autorouting.
The server checks the native draft title against the current provider catalog,
including manual changes that have not been saved on the thread.

Model and effort switches constrain both inference and fallback. Defaults enable
Astra low/medium/high/xhigh/ultra, Luna Max only, Fable high/xhigh/ultra (native
`ultracode`), and Opus high/xhigh. Sol remains an optional, disabled route for
existing configurable installations. New threads prefer the configured fallback,
then Astra Medium, then another enabled available route. Follow-up uncertainty
preserves the current selection even if that current effort is disabled for
future routing. Disabling model routing does not require an available fallback.

`bb.sdk.system.usageLimits` authorizes Opus only when a Fable usage window is
exhausted and has not reset. Unknown usage never authorizes this fallback.
Fable is excluded while its usage is exhausted. The destination machine's model
catalog and usage are checked again when project routing changes machines.

The general rule and per-route rules also drive agent delegation. The
`kitchen_sink_autorouter_policy` tool reads live settings and usage. Stable agent
instructions tell the coordinator to use BB subthreads for Luna command work,
Fable UI work from Codex, and independent reviews. Subthreads do their assigned
work without recursively delegating it. These are agent instructions, not an
automatic server-side thread launcher. BB installs newly contributed tools and
instructions when a provider session is constructed. Existing sessions receive
them on their next start/resume after restart, not in the middle of a live session.

## Approved temporary composer integration

The user approved hijacking Send and Enter on 2026-09-09. SDK 0.4.48 has no
asynchronous submit transformer or writable execution selection. This workaround
is contained in `src/app/autorouter`, with no BB core edits or React internals.
Replace it with the SDK submit transformer when one is available.

The SDK action installs capture listeners scoped to its native `data-promptbox`
form. It pauses Send clicks and plain desktop Enter, locks text input, runs
inference, drives BB's project and execution pickers, verifies the rendered
selection, then clicks the original Send button once. BB still handles draft
serialization, mentions, attachments, permissions, service tier, queues, and
submission errors. The native project picker copies project-owned attachments
before changing projects. The operation follows the new-thread composer across
that project change and refuses stale drafts or a vanished composer.

The DOM dependency is explicit: `data-promptbox-submit-action`,
`data-promptbox-project-control`, the model picker's accessible label and
`aria-controls`, project options' `data-value`, and native catalog labels in
menu rows and selection titles. If pickers cannot be found or the chosen
selection does not render, submission stops and keeps the draft. BB markup
changes require rerunning the isolated native composer verification.

Shift/modified Enter, IME composition, touch-keyboard newlines, typeahead
selection, voice and Stop buttons retain native behavior. Scheduled sends and
other plugin-triggered submissions are outside this temporary integration.
Repeated Send/Enter events share one routing operation. Event listeners and
input locks are released when the SDK action unmounts.

The native model/reasoning selector shimmers with the theme's yellow warning
color while inference and selection are pending. The attribute is removed on
success and failure. Reduced-motion users get a static highlight. There are no
routing notifications. The button tooltip and screen-reader status expose errors.
Changes to execution selection during inference stop submission and keep the draft.

## Index and settings

The user-only `/index-projects` skill writes one-line summaries and three distinct
example prompts for repositories under `~/git` through the validated index RPC.
The index preserves unregistered repositories with `projectId: null` and
separates hosts. Only registered project IDs are routing destinations.

The native plugin settings UI and indexing RPC use `bb.settings` as the sole
persistence owner. Users can edit the index, general rule, model/effort rules,
enabled models/efforts, and fallback in Kitchen Sink settings. New installs
default to the master switch off. Pausing one composer does not change that switch.
