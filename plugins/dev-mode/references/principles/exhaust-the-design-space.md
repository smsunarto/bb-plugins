# Exhaust the Design Space

Apply to engineering work only: an architectural, API, or system-design decision with no precedent in the codebase. Build 2-3 competing designs and compare side by side before committing. Not for visual, UI, game, or product design.

When an engineering decision has no established precedent, explore several concrete alternatives before implementation. Building the wrong structure costs more than exploring three options.

**The rule.** When the right answer is not obvious, sketch 2-3 competing designs. Compare them side by side. Only then commit. Design it twice is this rule by another name. A second flavor of the first shape does not count.

**When it applies:**

- Architectural choices with multiple viable approaches
- Module boundaries, interfaces, data models, and system design with no prior art in the codebase

**When it doesn't:**

- Visual, UI/UX, game, or product design. Build one direction and iterate on it with the user.
- Mechanical implementation where the pattern is established
- Bug fixes or refactors with a clear target state
- Changes where constraints dictate a single viable approach
