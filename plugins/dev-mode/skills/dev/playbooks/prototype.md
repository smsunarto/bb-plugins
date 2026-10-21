# Prototype

A throwaway sketch that settles a design or behavioral question cheaply. It's the place where speed beats polish: the rigor goes into choosing the right design, not into the code. The real build follows as a [Feature](feature.md).

Prototype when a question can be answered by observation (behavior, timing, layout, output) rather than by asking the user.

What tends to work:

1. Name the decision the prototype exists to make: which layout, interaction, or density, or which behavior, timing, or approach. Without a decision to make, it's probably a Feature.
2. When the design space is open, gather prior art and offer a few directions before building. Variations the user didn't ask for are welcome.
3. Build in a scratch directory outside production source, with the lightest stack that shows the idea: plain HTML, CSS, and JS with CDN dependencies for a visual question, the smallest script for a behavioral or timing question. Skip tests and abstractions.
4. To compare alternatives, put them behind one labeled switcher (buttons or a keypress). This is `exhaust-the-design-space` made cheap.
5. Observe the thing you're deciding: screenshot each variant and drive the interaction, or log the timing and print the output.
6. Present the alternatives, tradeoffs, and a recommendation, then hand the chosen direction to the real build.

A good reply shows the variants, the evidence (screenshots or observed output), the tradeoffs, your recommendation, and the scratch path, and says plainly that the prototype is throwaway.
