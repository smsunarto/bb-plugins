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

Wheel, touch, scrollbar dragging, and navigation keys interrupt automatic motion.
Native wheel and touch input remain unchanged. Editable controls retain their
navigation keys. Reduced motion disables the fade and settles scrolling
immediately, including when the preference changes during an animation.

## Experimental limitations

The scroll integration depends on bb's current timeline DOM structure and direct
`scrollTop` assignments. It changes synchronous write-then-read behavior because
the viewport takes time to reach the requested position. Reads always return the
physical position. Host code that immediately checks a write can temporarily
observe an intermediate position, including during clamped row reveals.

During the first offset restoration, the plugin ignores follow-up destinations
within 32px of the starting viewport for up to 250ms. This prevents bb's replayed
layout effects from replacing the saved destination with a transient top-row
anchor. Other layout destinations and bottom requests still apply. A programmatic
request near that starting position during this brief window can also be ignored.
Manual input, reduced motion, and content shrink corrections end this protection.

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
