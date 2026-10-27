Manage persistent Rampage client checkout slots, including master registration, warm-slot creation, and exclusive thread leases. Slots retain their Unity Library cache and GitButler state across tasks.

CHOOSING BETWEEN TOOLS
A slot leases the whole registered checkout. After acquiring it, use `game_studio_manage` to claim its exact Unity Editor. In unregistered checkouts, Editor claims and reservations alone coordinate access.

REGISTERING AND CREATING SLOTS

- `register` associates a stopped master checkout with its BB project and host.
- `create` uses `sourceSlotId` to create a warm slot at an absolute destination `path` on the same copy-on-write filesystem; optionally choose a new `scott/` branch.
- The master must be clean and stopped, with a populated Library and locally hydrated Git LFS objects. Creation freezes its lease, creates independent Git metadata, and natively clones the cache without Pipeline credentials or MPPM clones. Keep the master untouched while it seeds.
- Unsupported copy-on-write fails without a full-copy fallback. Completed retries preserve existing work; partial failures remain fenced for inspection.

ACQUIRING AND RELEASING

- Select the `unity-rampage-slot` BB provider with empty inputs to reserve an available warm slot, or give an explicit `slotId` for an adopted Project Checkout environment.
- `list` provides slot IDs and exposes lease IDs only to their owner. Acquire from a thread attached to that checkout, then claim its Editor.
- A registered slot's lease is acquired on thread dispatch. Keep it across idle turns, failures, and Editor restarts. Release only at handoff, after releasing Editor claims, closing Unity and its MPPM clients with dirty scenes preserved, and stopping other agents.

RECOVERY AND RETIREMENT

- Failed verification quarantines the slot. `recover` requires observed completion evidence and explicit confirmation; recovery by another caller also requires the owner to be archived or deleted.
- `retire` preserves all checkout files. Leases do not automatically expire or transfer, and this tool does not reset branches, stash, or delete checkout work.
