Store an image, agent trace or software map for a Whiteboard session to show. Pass a fresh UUID `id` and a registered `repositoryId`, then reference that `id` from a component: `image` `assetId`, `trace_quote` `traceId`, or `software_map` `mapVersionId`.

- "image": one PNG, JPEG or WebP of at most 20 megapixels, as `base64`; it is stored as PNG.
- "trace": a `label` and `events` with unique IDs, for `trace_quote`.
- "map": a software map `model` read at full commit `pins` on one `side`; its source ranges must exist there. Generate maps only when `whiteboard_session_capabilities` reports `softwareMapEnabled`.

Returns `id`, `kind` and `mimeType`. Input is limited to 8 MiB of JSON. Reusing an `id` with identical content returns the same resource; different content is rejected. A session with pins accepts only resources from its own repository, and a map only when its commit on its `side` is the session's commit on that side.
