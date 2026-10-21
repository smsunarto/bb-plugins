# Experience First

Apply to engineering tradeoffs that change what the work's consumers get: the behavior a feature's users rely on, the API a colleague imports, the code the next maintainer inherits. Choose their experience over implementation convenience. Not for visual, UI, game, or product design decisions; those follow the user's direction.

When implementation convenience conflicts with the consumer's experience, choose the experience.

- Every option, flag, parameter, and config key must be justified
- Ship less, ship better (three solid capabilities beat ten rough ones)
- Get the behavioral details right (defaults, error states, failure messages, feedback, recovery)
- Tighten the core path (every addition should serve the central workflow or get out of the way)

The user is whoever consumes the work. For a feature that is the end user who depends on its behavior. For a library or an internal API it is the colleague who imports it. The engineer who maintains the code next is a user too. Weigh their experience the same way, and explain impact from their perspective.

Foundations should serve the experience. Foundational thinking governs the _sequence_ of work. This principle governs the _target_.
