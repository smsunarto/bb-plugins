# Call tree

The pseudocode vocabulary projected onto one axis: who calls whom, in order. Indentation is the stack. Top to bottom is time.

```
DrainQueue
  WHILE store has pending jobs
    Store.TakeNext              // db
    SWITCH job.status
      CASE Pending
        Retry
          Store.Get             // db
          Store.Put             // db, or RETURN err
      CASE Done
        Store.Remove            // db

FetchAll
  FOR EACH url
    spawn Fetch                 // network
  Collect                       // blocks until len(urls) results
```

- One call per line. Children are the calls the parent makes, in order.
- Names match the declarations in the pseudocode: `Retry`, `Store.Get`. Name the interface on the call and the concrete type in a trailing comment when it matters: `Store.Get // MemStore`. When the tree is about one implementation, use Go's package form and drop the comment: `pg.Store.Get`.
- Only defined routines appear. Domain sentences from bodies stay out. A leaf is a routine with no children shown, or a boundary crossing.
- Boundaries are trailing comments: `// db`, `// network`, `// disk`, `// clock`. Reviewers scan for these lines.
- Flow markers are uppercase prefixes on their own line, children indented beneath. Use one only when the shape changes what gets called.
- Concurrency is a prefix on the call: `spawn Fetch`. Blocking is a comment.
- `or RETURN err` appears only where the tree short-circuits differently from its siblings.
- Keep the tree shallow enough to scan. Split a deep subtree into its own named view when that makes the relevant calls easier to follow.
- Switch to a sequence diagram when the boundaries between processes are the point.
