# NoVNC

Watch a thread's remote screen through NoVNC in a floating picture-in-picture panel.

## What it does

- Adds a composer toggle button on threads whose environment's remote host serves NoVNC on port 6080.
- The server checks reachability through the bb shared-port tunnel. It never installs NoVNC on the host.
- The toggle shows a floating PIP in the bottom-right corner with the live NoVNC session.
- Hovering the PIP reveals an "Open" pill. Clicking it expands the panel to nearly cover the bb UI.
- The expanded panel has a minimize button, and Escape also minimizes it.
- The iframe never remounts between the pip and expanded layouts, so the VNC session stays connected.

## Requirements

- The thread must run in an environment with an enrolled remote host.
- NoVNC must already be running on the host at port 6080 and serve `/vnc.html`.
