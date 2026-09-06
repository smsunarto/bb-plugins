# Smooth Thread Switch

Fades a switched-to conversation in once bb has scrolled it into place.

## What it does

Opening a thread remounts bb's conversation timeline. The rows first paint
scrolled to the very top, and only a few frames later does bb snap the view to
the bottom, or back to the row you had scrolled to. The latest rows can merge
in and shift things once more after that. On a fast machine that reads as a
flash of the oldest messages followed by a jump.

This plugin holds the freshly mounted row list invisible through that dance and
then fades it in over 180ms. It reveals as soon as bb has positioned the view
and the scroll geometry has held still for a frame, and never later than 350ms
after the rows mount, so a thread that is still streaming or was left at its
very top shows up on time.

## How it works

- One content script watches the app for a newly mounted top-level timeline row
  list, the `data-timeline-row-list="top-level"` element bb renders.
- The list gets a class that sets `opacity: 0` in the same mutation microtask
  it mounts in, before its first paint. Opacity leaves layout, scroll metrics,
  and bb's resize and intersection observers untouched, so bb's own
  bottom-anchoring and scroll restore run exactly as they would unhidden.
- Each animation frame samples the scroll area's `scrollTop`, `scrollHeight`,
  and `clientHeight`. The view counts as positioned once `scrollTop` moved, a
  scroll event fired, or the conversation fits without scrolling. One repeated
  sample after that lifts the hold.
- The reveal is a CSS animation. Under `prefers-reduced-motion` the hold
  remains, since it is not motion, and the fade is dropped.
- Rows streaming into an already visible list are ignored, a list that unmounts
  mid-hold is released, and the disposer strips every class and cancels every
  frame, so reloads leave no trace.

The plugin adds no settings, server behavior, or CLI commands.
