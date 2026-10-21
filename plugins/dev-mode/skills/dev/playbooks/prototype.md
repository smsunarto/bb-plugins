# Prototype

A throwaway sketch that settles an engineering question by observation: which behavior, timing, approach, data shape, or interface works. Speed beats polish here, and the rigor goes into asking the right question. The real build follows as a [Feature](feature.md).

Prototype when running something can answer the question instead of asking the user. Visual, UI, and product design exploration follows the user's direction and any design skill instead of this playbook.

What tends to work:

1. Name the decision the prototype exists to make. Without one, the work is probably a Feature.
2. Build in a scratch directory outside production source, with the smallest script or harness that exercises the question. Skip tests and abstractions.
3. To compare alternatives, build each as a labeled variant behind one entry point or flag. This is `exhaust-the-design-space` made cheap.
4. Observe the thing you're deciding: log the timing, print the output, or call the interface the way its consumer would.
5. Present the alternatives, tradeoffs, and a recommendation, then hand the chosen direction to the real build.

A good reply shows the variants, the observed evidence, the tradeoffs, your recommendation, and the scratch path, and says plainly that the prototype is throwaway.
