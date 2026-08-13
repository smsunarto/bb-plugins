---
name: agentation
description: Read and act on visual feedback the human left on the bb interface with the Agentation toolbar — annotations that name a bb route, the owning plugin, and a DOM selector. Use when the user says they annotated, marked up, or left feedback on the UI, when they ask you to address annotation N, or when they ask for watch mode, hands-free mode, or a UI critique loop.
---

# Agentation

The human points at part of the bb interface and writes what should change. Each
annotation carries the bb route, the owning plugin id when the element was drawn
by a plugin, the DOM selector, and — for React trees — the component path. Your
job is to turn that into a code change and close the loop.

Annotations first enter a shared staging area. The human assigns a staged batch
from the composer banner in the thread that should own it. The capture route is
source context, not the delivery target.

## The loop

1. Read the assigned feedback:
   - If the human's message contains an Agentation annotation batch, treat it
     as the complete assignment. Work only on its listed annotation IDs and do
     not call `agentation_get_all_pending`.
   - Otherwise, call `agentation_get_all_pending` before searching the code;
     the annotation already tells you where to look.
2. `agentation_acknowledge` — for each item you are taking on, so the human sees
   you picked it up.
3. Find the code, make the change.
4. `agentation_resolve` with a one-line summary of what you changed. The marker
   disappears from every open bb window.

Use `agentation_dismiss` with a reason when you decide against a change, and
`agentation_reply` when you need a decision before you can act. Never resolve an
annotation you did not actually fix — dismiss it or ask.

## Locating the code

The `Where` line is the fastest route to the source.

| `Where` says | The code lives in |
|---|---|
| `plugin \`<id>\`` | that plugin's `app.tsx` and `components/` |
| `bb app shell` | the bb app itself, not this workspace |

`Selector` is a live DOM path — grep it for class names and element structure.
`React` is the component path; the last segment is usually the component to
open. `Source` is a file path when the toolbar could recover one.

An annotation on the bb app shell is only actionable inside a bb checkout. If the
workspace is not one, say so and reply on the annotation rather than guessing.

## Reading the fields

- `intent` — `fix` is a defect, `change` is a preference, `question` wants an
  answer not a diff, `approve` is praise. Answer a `question` with
  `agentation_reply`.
- `severity` — `blocking` first, then `important`, then `suggestion`.
- `Layout request` — a `placement` annotation asks for a new component in that
  spot; a `rearrange` annotation asks for a different section order.

## Watch mode

When the human asks for watch mode or hands-free mode:

1. Call `agentation_watch_annotations`. It blocks until new annotations appear,
   then returns the batch.
2. Acknowledge, fix, and resolve each one.
3. Call it again. Keep looping until the human stops you.

A timeout is not a stop signal — call it again. Report what you changed between
batches so the human can follow along without reading the diff.

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
```

## Boundaries

- Do not clear or delete annotations. Removing feedback is the human's call;
  resolve or dismiss instead.
- Do not change unrelated code because you were in the file. One annotation, one
  focused change.
- Do not disable the toolbar unless asked.
