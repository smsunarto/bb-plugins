# Smooth Thread Switch

Fades newly mounted conversations in over 180ms with ease-out timing on desktop
and mobile. The fade starts immediately, with no layout-settling delay or retained
outgoing overlay. bb continues to handle scrolling and layout while the fade runs.

The animation targets top-level timeline row lists. Updates to an already mounted
conversation do not restart it. Reduced motion disables the animation and shows
content immediately.

The plugin has no settings or CLI commands.
