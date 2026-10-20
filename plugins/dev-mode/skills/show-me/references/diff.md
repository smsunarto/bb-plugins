# Diff

Use a `diff` fence for a proposed or historical change when the surrounding shape already exists. Match the diff shape to the topic. Follow the host's citation rules. In BB, do not duplicate this turn's changes when Last Turn already renders them.

A component change:

```diff
 <SessionPage>
   useSessionEvents()
   <SessionToolbar>
+    <RunSkillButton />
   <SessionTimeline>
+    <SkillResultCard />
```

A file-layout change. Use a `patch` fence, not `diff`: it keeps the add and remove shading, and bb Monokai tightens its leading so the box-drawing connectors join.

```patch
 src/
 ├── commands/
+│   └── show-me.ts       # expands the slash command
 ├── sessions/
-└── transport.ts
+└── transport/
+    ├── client.ts
+    └── stream.ts
```

A call-tree change:

```diff
 Retry
   Store.Get
+  Backoff                      // clock
   Store.Put
```

A control-flow change, in the pseudocode shape:

```diff
 func Save(content: Content) Result<Saved> {
+    IF content is unchanged { RETURN Ok(cached result) }
     write content
+    invalidate cache
     RETURN Ok(fresh result)
 }
```
