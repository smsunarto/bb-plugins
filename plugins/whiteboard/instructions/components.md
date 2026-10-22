## Components

`whiteboard_session_edit` takes one component in `edit.content`, named by its `type`. The host assigns durable IDs. Use the returned IDs for later edits. The notation below lists fields inside the component; `?` marks an optional field.

### Prose and containers

- `markdown {markdown, pins?}`
- `code {text, language?, caption?}` for illustrative code; use a `code_peek` for repository code.
- `divider {}`
- `section {title, children: component[], defaultCollapsed?}`
- `callout {children: component[], title?, tone?: info|warning|danger|success}`
- `image {assetId, alt, caption?}` with an asset ID returned by `whiteboard_session_upload`.
- `trace_quote {traceId, eventId, text}` for an uploaded trace resource.
- `software_map {mapVersionId, focusElementId?}` for an uploaded map. Generate a map only when `softwareMapEnabled` is true.

A section uses `children`; a Markdown block uses `markdown`. To populate a section later, insert each child with `edit.parentId` set to the section's returned ID.

```json
{"type":"section","title":"What changes","children":[{"type":"markdown","markdown":"The client retries a failed request."}]}
```

### Sources and code peeks

A `source` selects a repository-relative file with 1-based inclusive endpoints:

`{file, start: {side: "base"|"head", line}, end: {side: "base"|"head", line}, pins?: {repositoryId, head, base?}}`

Sources without explicit pins use the review's pins. A scratchpad source must carry its own pins; read the scratchpad topic for that workflow. A Markdown block can supply pins for its `review-source:` links.

- `code_peek {source, caption?}`

Replace every example path and line with code you have read at the selected pins.

```json
{"type":"code_peek","source":{"file":"src/client.ts","start":{"side":"head","line":10},"end":{"side":"head","line":20}}}
```

### Sequences

- `sequence {title, actors: {key: label}, steps: step[]}`
- `step {from, to, label, style?: call|return|async, source? | explanation? | code?: {text, language?}}`

Each step references declared actor keys and has exactly one of `source`, `explanation`, or `code`. Its source is the calling, returning, or emitting line at the `from` actor; the callee's body belongs in the next step.

```json
{"type":"sequence","title":"Request","actors":{"client":"Client","server":"Server"},"steps":[{"from":"client","to":"server","label":"Send request","source":{"file":"src/client.ts","start":{"side":"head","line":10},"end":{"side":"head","line":12}}}]}
```

### Flows

- `flow_diagram {title, nodes: flow_node[], edges: flow_edge[], description?, direction?: right|down}`
- `flow_node {key, label, description?, kind?: process|decision|terminal, attachments?: {label, sources: source[]}[]}`
- `flow_edge {from, to, label?, style?: solid|dashed}`

A flow has 1–100 nodes and up to 300 edges. Node keys are unique; each edge names declared keys. Empty edges are valid. Insert a new flow node into an existing diagram with a `link` naming either `from` or `to` an existing node, plus optional `label` and `style`.

```json
{"type":"flow_diagram","title":"Request outcome","nodes":[{"key":"send","label":"Send request"},{"key":"done","label":"Show response","kind":"terminal"}],"edges":[{"from":"send","to":"done","label":"Success"}]}
```

### Call-stack comparisons

- `call_stack_diff {title, base: frame[], head: frame[]}`
- `frame {source, label?, key?, parentKey?, callSite?, contextSources?: source[], via?: {kind: call|queue|callback|rpc, reason}}`

Both side arrays are required; either can be empty. A `parentKey` names an earlier frame on the same side. `callSite` identifies the caller's invocation; `contextSources` add supporting code owned by this frame.

```json
{"type":"call_stack_diff","title":"Request entry","base":[],"head":[{"label":"Handle click","source":{"file":"src/client.ts","start":{"side":"head","line":10},"end":{"side":"head","line":20}}}]}
```

### Database lenses

- `database_lens {title, actors: {key: label}, stores: {key: store}, useCases: useCase[]}`
- `store {label, storage: relational|document, collections: {key: {label, fields: {key: field}}}, dataStoreKind?: database|objectStore|bucket|artifactStore|fileStore}`
- `field {label, dataType, nullable?, primaryKey?, references?: {store, collection, field}, example?, fields?: {key: field}}`
- `useCase {label, summary?, operations: operation[]}`
- `operation {kind: read|write, actor, store, collection, label, source, field?, detail?}`

Provide at least one store and use case, and at least one operation per use case. Operations name declared actor, store, collection, and field keys. Each operation cites the code that performs it.

```json
{"type":"database_lens","title":"Read items","actors":{"app":"App"},"stores":{"db":{"label":"DB","storage":"relational","collections":{"items":{"label":"Items","fields":{"id":{"label":"ID","dataType":"integer"}}}}}},"useCases":[{"label":"Load items","operations":[{"kind":"read","actor":"app","store":"db","collection":"items","label":"Fetch items","source":{"file":"src/items.ts","start":{"side":"head","line":10},"end":{"side":"head","line":20}}}]}]}
```
