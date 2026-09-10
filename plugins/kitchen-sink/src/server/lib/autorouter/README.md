# Autorouter

The composer toggle persists through `bb.settings`. When enabled, a single
Codex `gpt-5.6-luna` completion with `medium` reasoning selects a project and a
whitelisted model/effort pair. Kitchen Sink calls its own BB host entry. The
host uses the shared `@bb-plugins/codex-inference` transport also used by GTD
thread naming. Credentials stay on the host. The request has no tools, a strict
JSON response schema, and a 20-second deadline. It never retries inference.

Project routing compares explicit instructions first, then the editable index.
Uncertain project selection keeps the current project. Follow-up messages keep
the existing project, provider, and model. Only Astra follow-ups route reasoning.
Other models submit their current selections without inference. Astra routing
reads the native draft selection, restricts every decision to Astra, and keeps
its current reasoning on uncertainty or failure. New threads use the configured
fallback on uncertainty or failure. Current provider
catalogs validate model IDs and effort levels. An unavailable fallback leaves
the draft unsent with an error.

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

An SDK app overlay displays an eight-second, dismissible Autorouted notification
after the native submission resumes. It shows the applied project, model, and
reasoning, or just Astra reasoning for follow-ups. Fallbacks are labeled. The
overlay stays mounted across new-thread navigation. Changes to execution
selection during inference stop submission and keep the draft.

## Index and settings

The user-only `/index-projects` skill writes one-line summaries and three distinct
example prompts for repositories under `~/git` through the validated index RPC.
The index preserves unregistered repositories with `projectId: null` and
separates hosts. Only registered project IDs are routing destinations.

The native plugin settings UI, toggle, and indexing RPC all use `bb.settings` as
the persistence owner. Users can edit the index, every model/effort rule, and the
fallback in Kitchen Sink settings. New installs default to autorouting off.
