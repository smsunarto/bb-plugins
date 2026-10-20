---
name: show-me
description: Explain a topic with a compact visual when relationships, behavior, or changes are clearer visually. Use for show-me requests or a visual explanation.
---

# Show me

Pick the smallest view that answers the current question. Put it beside the short text
it supports. Read only the matching reference before drawing. Its conventions provide a
consistent default, while the user's requested format and the host's rendering constraints
take precedence.

| Explain                                                         | Read                                               |
| --------------------------------------------------------------- | -------------------------------------------------- |
| Logic or an algorithm                                           | [Pseudocode](references/pseudocode.md)             |
| Runtime control flow                                            | [Call tree](references/call-tree.md)               |
| Cross-process interaction or data flow                          | [Sequence diagram](references/sequence-diagram.md) |
| UI structure                                                    | [Component tree](references/component-tree.md)     |
| File responsibilities or a broad refactor                       | [File tree](references/file-tree.md)               |
| Changes within an existing structure                            | [Diff](references/diff.md)                         |
| New code whose ownership or order matters, or a copyable target | [Code block](references/code-block.md)             |
| Layout, visual states, or a concept that needs a custom view    | [HTML visual](references/html-visual.md)           |

Keep only the calls, files, props, states, and boundaries needed for the question. One
view usually suffices. Add another when it answers a different question. Distinguish
observed behavior from proposed designs in the visual itself.
