# Grug Brain

Apply before designing, implementing, debugging, or refactoring software, and when sizing a diff or adding abstractions, layers, or signal threading. Reduce maintainer effort, dependencies, and obscurity. Prefer deletion and the smallest change that fixes the responsible boundary.

Treat your own cleverness with suspicion. Use working code and concrete changes to test your understanding. Judge simplicity by what the next developer must learn and do, not by how easily you generated the implementation.

Use this outlook while building, debugging, and refactoring, not only during a final review. Grug supplies the attitude. John Ousterhout's *A Philosophy of Software Design* supplies the following model of complexity.

## Principles

### 1. Judge simplicity by maintainer effort

Complexity is the difficulty a system's structure imposes on understanding and changing it. It is experienced by a developer attempting a particular task. A sophisticated system can be simple to work on. A tiny system can be difficult to change safely.

Do not substitute line count, class size, number of layers, novelty, or lack of abstraction for this definition. More implementation code can make a system simpler if it removes knowledge and obligations from its callers. Less code can make it harder if it conceals assumptions or requires delicate coordination.

Look for three symptoms:

- **Change amplification:** one conceptual change requires coordinated edits in several places. Ask which decision has been spread across those places.
- **Cognitive load:** a developer must learn too much to complete a task correctly. Count the concepts, call ordering, ownership rules, exceptions, and implementation details they must keep in mind.
- **Unknown unknowns:** the developer cannot tell what else must change or what they need to know. A locally reasonable edit silently breaks a distant assumption. This is worse than an explicit, discoverable dependency.

Weight these costs by how often developers encounter them. Complicated internals behind a stable interface may matter less than a small awkward API everyone uses. Isolating complexity so ordinary work never encounters it is a substantial improvement.

### 2. Trace complexity to dependencies and obscurity

**Dependencies** mean one part cannot be understood or changed without considering another. These include shared assumptions and coordinated behavior, not just imports and calls. A reader and writer can depend on the same file format without calling each other. Duplicating a policy creates a dependency even when the code looks independent.

**Obscurity** means important information is not apparent: ambiguous units, inconsistent names, hidden ordering constraints, undocumented ownership, or a dependency that cannot be discovered from the relevant interface.

Dependencies produce change amplification and cognitive load. Obscurity produces unknown unknowns and adds cognitive load. Dependencies cannot all disappear. Replace unnecessary or hidden dependencies with fewer, simpler, explicit ones.

For a proposed simplification, name the dependency or obscurity it removes. Moving code, renaming a wrapper, or making each file shorter is not sufficient evidence.

### 3. Hide decisions behind deep modules

A deep module provides substantial functionality through an interface that is simpler to understand than its implementation. Depth means useful complexity hidden, not a deep call hierarchy.

The interface includes **everything callers must know**, including informal rules about lifetime, ordering, side effects, errors, and concurrency. A one-line signature with many unwritten obligations is not a small interface.

Choose boundaries around knowledge and design decisions. Keep a decision inside one owner so it can change without coordinated edits elsewhere. Making fields private does not hide a representation if callers reconstruct it through getters or must still understand it.

Do not hide facts that remain necessary for correctness. If callers must know whether a write is durable, omitting that fact creates a false abstraction. Simplify the obligation where possible and make the remaining contract explicit.

### 4. Reduce total complexity, not just the current function

Handle unavoidable mechanism details in the module responsible for them when this removes repeated work from callers. A more involved implementation is worthwhile if many callers become simpler. Do not push decisions outward through configuration flags, callbacks, or exceptions merely to make implementation easier. Expose a choice when the caller has relevant knowledge the module lacks.

Keep unrelated application policy out of general mechanisms. Pulling complexity downward must simplify the overall design, not produce a module that knows about everything.

### 5. Let boundaries earn their cost

Splitting code adds interfaces, navigation, and coordination. Combine pieces when they share knowledge or cannot be understood separately. Separate pieces when their contracts allow independent understanding and change. Execution order alone is a poor reason to put steps into different modules.

Watch for shallow wrappers and adjacent layers that repeat the same abstraction. Each boundary should hide a decision or provide a distinct abstraction. A wrapper is justified by the burden it removes, not by its existence as a named layer.

### 6. Generalize for today's needs

Do not become categorically anti-abstraction or anti-generality. A somewhat general interface can express today's needs with fewer concepts and special cases. Implement the functionality needed now without tying the interface to every caller's particular workflow. Avoid speculative capabilities that enlarge the contract.

### 7. Consolidate duplicated knowledge

Distinguish similar text from duplicated knowledge. Modest textual duplication may be cheaper than a complicated shared interface. Repeating the same policy across callers creates coordinated change and usually calls for a single owner.

### 8. Correct boundaries before complexity accumulates

Complexity accumulates through small concessions. A patch that works but adds another exception, coupling, or hidden rule has a continuing cost. Invest in correcting the responsible boundary within the task's scope instead of repeatedly patching its callers. Preserve necessary complexity and required behavior. The goal is easier future work, not the smallest immediate diff or a hypothetical perfect architecture.

## Keep the change small

Choose the boundary that reduces maintainer effort first. Then minimize the diff within that boundary, without leaving the root cause in place to save lines. Aim for the most result with the least code and complexity.

- **Prefer deletion.** Look for removals before additions when refactoring or improving code.
- **Keep call hierarchies flat.** A rich interface that hides substantial work is not a deep call chain. If understanding behavior requires tracing more than three files or layers, look for pass-throughs and flatten unnecessary indirection. Preserve boundaries that hide useful complexity.
- **Consolidate decisions.** Keep each choice behind one source of truth and expose the result without making callers repeat the policy.
- **Minimize the diff.** Prefer the smallest change that fixes the responsible boundary. Fewer lines beat elegant boilerplate when behavior and maintainer effort are otherwise equal.
- **Question signal threading.** Before passing a new signal through types, schemas, pipelines, or similar layers, look for a more direct path that preserves ownership and required behavior.
- **Sweat small leaks.** Remove tiny pass-throughs, representation leaks, and duplicated choices before they become permanent coordination costs.

If a human developer would find the result exhausting to maintain, it is a bad solution.

## Apply the model to an actual change

Start with the task a maintainer must perform. Trace what they must read, know, and edit. Identify the symptom, then its underlying dependency or obscurity. Compare candidate designs by the knowledge and coordination each requires across the whole affected path.

For example, separate `FileReader` and `FileWriter` classes may both encode a format's field order, escaping, and version rules. Each class is short, yet a format change requires synchronized edits. An owner that provides `read` and `write` while containing those decisions reduces complexity. Moving the shared constants into a third file does not solve the problem if both callers still implement the format rules.

Verify both behavior and the design claim. If a representation is supposed to be hidden, inspect consumers for leaked assumptions. If a policy is supposed to have one owner, trace every path that applies it. State what callers no longer need to know and which edits a future change no longer requires.

## Explain the concrete application

In your response, explain how Grug Brain shaped your approach. Name the principle and the concrete decision it influenced, such as a module boundary, API, abstraction, or ownership choice. Explain what knowledge, dependency, or coordinated work that choice removes. For example: "Hide decisions behind deep modules shaped the format module: it owns both parsing and writing, so callers no longer coordinate field-order rules." A generic claim that you followed the skill is insufficient.
