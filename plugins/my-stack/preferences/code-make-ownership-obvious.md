---
way: my-code-way
description: Scott's preferences when shaping code structure, domain ownership, or an abstraction.
---

# Make ownership obvious

Make the owner of a concept easy to find and its behavior easy to trace
without jumping through wrappers. Keep one authoritative representation of
domain state. Avoid caller-specific copies and synchronized mappings.

Prefer concrete names, cohesive files, small APIs, and a visible dependency
direction over clever compression or speculative extensibility. Introduce
abstractions when they make the domain easier to understand.
