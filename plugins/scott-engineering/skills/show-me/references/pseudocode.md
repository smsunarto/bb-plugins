# Pseudocode

Structured English with Go's declarations. The reader knows the problem domain, not the code. Use explicit control flow for the decisions the reader needs to understand. A domain operation can remain a single line when its implementation is not the question.

## Shape

Types, params, and returns are explicit. Bodies are domain sentences. Braces mark every block. Control flow is uppercase so a skim lands on the flow first. Fenced blocks carry no language tag.

```
errors {
    ErrNotFound      // no job with that id
    ErrTooManyTries  // attempts reached the cap
}

type ID = string
type Status enum { Pending, Running, Done }

type Job struct {
    id: ID
    status: Status
    attempts: int          // never exceeds 3
    embeds Logger
}

type Store interface {
    Get(id: ID) Result<Job>
    Put(job: Job) Error?
    List(status: Status) []Job
}

type MemStore struct {     // implements Store, safe for concurrent use
    jobs: map[ID]Job
}

func Retry(store: Store, id: ID) Result<Job> {
    job = store.Get(id) or RETURN wrap(err, "retry")
    IF job is already done { RETURN Ok(job) }
    IF job has reached the attempt cap { RETURN ErrTooManyTries }

    increment job.attempts
    set job.status to Pending
    store.Put(job) or RETURN err
    RETURN Ok(job)
}

func (s MemStore) Get(id: ID) Result<Job> {
    IF id is empty { RETURN ErrNotFound }
    job = s.jobs[id] or RETURN ErrNotFound
    RETURN Ok(job)
}

func DrainQueue(store: Store) Error? {
    WHILE store has pending jobs {
        job = take the next pending job from store or RETURN err
        SWITCH job.status {
            CASE Pending: Retry(store, job.id) or RETURN err
            CASE Done:    remove job from store
            DEFAULT:      log unexpected status for job
        }
    }
    RETURN none
}
```

## Declarations

- `type Name = Primitive` for aliases. Name the domain: `type ID = string`.
- `type Name enum { A, B }`, `type Name struct { }`, `type Name interface { }`.
- Fields and params are `name: Type`. The return type follows the parameter list with a space: `Get(id: ID) Result<Job>`. Tuples go in parens: `(Job, Error)`.
- Collections take Go form: `[]Job`, `map[ID]Job`, `chan Result`. Sets are `set[ID]`. `[]T` is any ordered sequence. When the order carries meaning, say it in a trailing comment: `order: []Entry // front is most recent`.
- Primitives are Go's names plus `time` and `duration`. Alias them into the domain like any other: `type Deadline = time`.
- `Job?` may be absent. `Result<Job>` can fail. `Error?` is failure only. A signature without `Result` cannot fail.
- Methods use Go's receiver: `func (s MemStore) Get(...)`. Bodies stay outside the type. Interfaces hold signatures only.
- Constructors are `func NewCache(capacity: int) Result<Cache>`. Validation guards come first. The success line is prose: `RETURN Ok(a Cache with that capacity and no entries)`.
- `implements`, embedding, and concurrency guarantees are trailing comments on the struct line: `// implements Store, safe for concurrent use`.
- One `errors { }` block per module, next to the interface that produces them.

## Bodies

- Locals carry no `let`, no `var`, no type. The right-hand side names it: `results = new chan Result`.
- Domain verbs come first on the line, lowercase: set, get, read, compute, increment, add, remove, append, find, send, log.
- A lowercase sentence is an obvious operation the implementer writes inline. A PascalCase call is a defined routine with its own pseudocode. PascalCase says nothing about visibility. Private helpers use it too.
- Bounds are domain terms: `FOR EACH item in items`, never `i = 1 to n`.
- Guards come first, in order: `assert` invariants (a bug), input validation (RETURN an error), degenerate inputs (RETURN a value). Then the happy path.
- Empty branches get inverted away. `ELSE { do nothing }` means the condition is backwards.
- Expand a domain operation such as "find the customer with the highest balance" when its iteration or selection logic is the point. Otherwise the named operation can remain compact.

## Control flow

Six constructs, uppercase, braces close them. Uppercase means flow and nothing else. Action verbs stay lowercase.

| Construct      | Spelling                                   |
| -------------- | ------------------------------------------ |
| decision       | `IF cond { } ELSE { }`                     |
| test at top    | `WHILE cond { }`                           |
| test at bottom | `REPEAT { } UNTIL cond`                    |
| iteration      | `FOR EACH item in items { }`               |
| multiway       | `SWITCH expr { CASE a: ... DEFAULT: ... }` |
| exit           | `RETURN`, `CONTINUE`, `BREAK`              |

Swapping `REPEAT UNTIL` for `WHILE` flips the condition. `UNTIL queue is empty` becomes `WHILE queue has items`.

## Errors

| Need               | Spelling                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| propagate          | `x = Call() or RETURN err`                                                                                |
| add context        | `or RETURN wrap(err, "loading job")`                                                                      |
| fall back          | `x = Call() or default`                                                                                   |
| raise              | `RETURN ErrOverflow`                                                                                      |
| branch on presence | `x = m[k]` then `IF x is absent { ... }`                                                                  |
| branch on kind     | `job, err = store.Get(id)` then `SWITCH err { CASE none: ... CASE ErrNotFound: ... DEFAULT: RETURN err }` |

## Left out on purpose

Omit language plumbing such as `package`, imports, `:=`, `->`, and `err != nil` blocks when it does not explain the behavior. A blocking wait can be one line: `wait for interval to elapse or stop to fire`.

Show locks, cleanup, ownership, and cancellation explicitly when correctness depends on their order. A concurrency-safety comment can summarize an established guarantee, but cannot replace the mechanism in a concurrency explanation.

## During implementation

For a detailed implementation plan, temporary comments can help map pseudocode to source. Remove comments that merely repeat the completed code. An explanation-only request does not require source edits.
