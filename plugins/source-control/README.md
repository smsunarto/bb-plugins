# Source Control

One **Change** per branch: the checkout's state from the host that has it, and its GitHub pull request from a site with a signed-in `gh`, shown the same way on every bb surface.

Status: Phase 1 of the Source Control plan. It adds a thread **Changes** tab beside the existing GitButler and Review plugins, which stay installed until cutover.

- **Local facet:** read on the thread's own checkout host with plain git.
- **Forge facet:** read with `gh` on the bb server when it is signed in, otherwise on the checkout's host.
- **Freshness:** the server reads a thread only while its tab is visible, keeps each facet's last good value, and labels it with when it was read and what is wrong now.
