---
name: agentation
description: Act on bb UI feedback from Agentation annotations or supplied batches. Use for annotated UI, numbered feedback, watch mode, hands-free mode, or critique loops.
---

# Agentation

The human points at part of the bb interface and writes what should change. Each
annotation carries the bb route, the owning plugin id when the element was drawn
by a plugin, the public SDK registration and item id when detectable, the DOM
selector, and — for React trees — the component path. Your job is to turn that
into a code change and close the loop.

Annotations first enter a shared staging area. The human assigns a staged batch
from the composer action button in the thread that should own it. The capture route is
source context, not the delivery target.

## The loop

1. Read the assigned feedback:
   - If the human's message contains an Agentation annotation batch, treat it
     as the complete assignment. Work only on its listed annotation IDs and do
     not call `agentation_get_all_pending`.
   - Otherwise, call `agentation_get_all_pending` before searching the code;
     the annotation already tells you where to look.
2. Check status and assignment; leave work acknowledged by another thread with
   that thread. Call `agentation_acknowledge` for each item you take on.
3. Locate the code using the targeting fields below, then make and verify the change.
4. `agentation_resolve` with a one-line summary of what you changed. The marker
   disappears from every open bb window.

Use `agentation_dismiss` with a reason when you decide against a change, and
`agentation_reply` when you need a decision before you can act. Never resolve an
annotation you did not actually fix — dismiss it or ask.

## Locating the code

The `Where` and `Plugin UI` lines are the fastest route to the source.

| Location says     | The code lives in                                      |
| ----------------- | ------------------------------------------------------ |
| `plugin \`<id>\`` | that plugin's `app.tsx` registration and `components/` |
| `bb app shell`    | the bb app itself, not this workspace                  |

For plugin-owned UI, start with the exact registration named on `Plugin UI` in
the plugin's `app.tsx`. Its optional `registration` id narrows the match when a
plugin contributes several items to the same surface. Then use `Selector`, a
live DOM path, for class names and element structure. `React` is the component
path; the last segment is usually the component to open. `Source` is a file path
when the toolbar could recover one.

An annotation on the bb app shell is only actionable inside a bb checkout. If the
workspace is not one, say so and reply on the annotation rather than guessing.

## Reading the fields

- `intent` — `fix` is a defect, `change` is a preference, `question` wants an
  answer not a diff, `approve` is praise. Answer a `question` with
  `agentation_reply`.
- `severity` — `blocking` first, then `important`, then `suggestion`.
- `Layout request` — a `placement` annotation asks for a new component in that
  spot; a `rearrange` annotation asks for a different section order.

## Choosing a read tool

- `agentation_get_all_pending` reads pending and acknowledged feedback across pages;
  optionally filter by the owning `pluginId`.
- For a known `sessionId` from a batch or `agentation_list_sessions`, use
  `agentation_get_pending` for open items or `agentation_get_session` for complete
  history, including resolved and dismissed items.
- `agentation_list_sessions` discovers pages, routes, session IDs, and status counts;
  it is unnecessary when the batch already identifies the page.
- Read results carry the bb route and source-targeting fields described above.
  Use their `annotationId` values for acknowledgement, replies, resolution, or dismissal.

## Watch mode

When the human asks for watch mode or hands-free mode:

1. Handle existing feedback first: use the supplied batch, or
   `agentation_get_all_pending` (`agentation_get_pending` for one known page).
2. Call `agentation_watch_annotations`. It returns open annotations created or
   changed since the call began, including replies and status updates; it does
   not return all previously open feedback. Optionally limit it to a `sessionId`.
3. Inspect each returned item's current status and assignment. Leave work already
   acknowledged by another thread with that thread. Acknowledge the items you
   take on, fix and verify them, then resolve; dismiss declined changes with a
   reason or reply when clarification is needed.
4. Report changes between batches, then watch again until the human stops you.

`timeoutSeconds` bounds waiting for activity (default 120); after the first
change, `batchWindowSeconds` collects more changes (default 10). A timeout returns
a notice, not a feedback batch or stop signal: call again to keep waiting.

## Shell equivalent

Every tool has a CLI form for environments where the shell is easier:

```sh
bb agentation pending [--plugin <id>] [--json]
bb agentation staged [--json]
bb agentation send <threadId> [annotationId…]
bb agentation restage <annotationId>
bb agentation show <annotationId>
bb agentation resolve <annotationId> fixed the wrapping
bb agentation dismiss <annotationId> intentional, matches the design system
bb agentation reply <annotationId> should this be 24px or 16px?
bb agentation toolbar off
bb agentation <command> --help
```

## Boundaries

- Do not clear or delete annotations. Removing feedback is the human's call;
  resolve or dismiss instead.
- Do not change unrelated code because you were in the file. One annotation, one
  focused change.
- Do not disable the toolbar unless asked.
