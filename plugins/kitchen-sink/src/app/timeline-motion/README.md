# Thread switching

Fades newly mounted conversations in over 180ms with ease-out timing on desktop
and mobile. Updates to an already mounted conversation do not restart the fade.
Reduced motion disables it. Scrolling is bb's own; this plugin does not touch it.

## Jump to latest event

Thread motion has no CLI commands. It registers one command-palette entry,
"Jump to latest event" (default shortcut Mod+Shift+J, rebindable under Keyboard
Settings as `plugin:kitchen-sink/jump-to-latest-event`). It scrolls the pane
showing the current thread to its live tail: it clicks bb's own "Scroll to
latest event" button when that is showing, and otherwise sets the timeline's
`scrollTop` to its bottom. The entry is hidden on surfaces without a thread.

bb's timeline DOM does not name its thread, so the plugin registers a
thread-header action that renders one hidden marker per visible pane carrying
that pane's thread id. Its host wrapper is hidden with CSS and draws no
control. The command finds the pane through that marker, so a split layout
scrolls the right pane. A marker with several timelines beside it (a container
of panes rather than one pane) scrolls nothing.

## Limitations

The command depends on bb's current timeline DOM structure
(`[data-thread-window] .thread-scrollbar`) and its "Scroll to latest event"
button label.
