# Smooth Thread Switch

Fades newly mounted conversations in over 180ms with ease-out timing on desktop
and mobile. Updates to an already mounted conversation do not restart the fade.

Experimental Lenis scrolling animates bb's automatic bottom following and saved
position restoration when switching threads. A newly mounted timeline's first
bottom placement and its layout corrections during the next 250ms are immediate.
Empty layout writes do not consume that initial placement. Later bottom requests
and content growth animate. An offset request or manual scrolling ends settling.
The plugin intercepts timeline `scrollTop` writes before layout effects finish.
It follows a growing bottom without restarting for repeated requests. bb owns
saved thread positions. The plugin keeps no separate thread-position cache.

Switching to a thread that is working opens it at the live tail rather than the
position it was left at. That saved offset sits behind rows the reader has not
seen yet, and the thread keeps appending more. A settled thread still returns to
its saved position, and only the first restore is redirected — once the reader
is in the thread, their own scrolling stands.

Wheel, touch, scrollbar dragging, and navigation keys interrupt automatic motion.
The timeline's “Scroll to latest event” button immediately resumes smooth bottom
scrolling, including during the manual-input grace period or a held gesture.
Native wheel and touch input remain unchanged. Editable controls retain their
navigation keys. Reduced motion disables the fade and settles scrolling
immediately, including when the preference changes during an animation.

## Experimental limitations

The scroll integration depends on bb's current timeline DOM structure, its
“Scroll to latest event” button label, and direct `scrollTop` assignments.
It changes synchronous write-then-read behavior because
the viewport takes time to reach the requested position. Reads always return the
physical position. Host code that immediately checks a write can temporarily
observe an intermediate position, including during clamped row reveals.

During the first offset restoration, the plugin ignores follow-up destinations
within 32px of the starting viewport for up to 250ms. This prevents bb's replayed
layout effects from replacing the saved destination with a transient top-row
anchor. Other layout destinations and bottom requests still apply. A programmatic
request near that starting position during this brief window can also be ignored.
Manual input, reduced motion, and content shrink corrections end this protection.

bb states no runtime status in the timeline's DOM, so the plugin registers a
thread-header action that renders one hidden marker per visible pane carrying
that pane's thread id and whether it is working, read from the same sidebar
thread view bb's own sidebar uses. Its host wrapper is hidden with CSS and draws
no control. A timeline with no marker above it, or with several (a container of
panes rather than one pane), keeps bb's saved position.

Native `scrollTo`, `scrollBy`, and `scrollIntoView` calls are not intercepted.
Scroll requests outside the recognized thread timeline stay native. Enabling the
plugin after a thread has restored its position cannot animate that past restore.
Content growth that resembles prepended rows is compensated immediately when the
viewport is away from the bottom. Content shrink corrections are also immediate.

Disabling the plugin removes its scroll listeners, observers, animation loop,
and anchoring styles. It restores the native `scrollTop` descriptor unless another
plugin has replaced that descriptor afterward. In that case, the later patch
stays installed and this plugin's router becomes a native passthrough.

The plugin has no settings or CLI commands.
