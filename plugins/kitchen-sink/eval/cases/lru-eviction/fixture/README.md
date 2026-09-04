# cache-layer

An in-process cache for read-heavy services. Every entry carries a byte weight
and a deadline, and the cache holds two ceilings at the same time: a live entry
count and a summed weight.

Recency lives in an intrusive doubly linked list, so a hit reorders an entry
without walking anything. Callers can pin an entry to hold it against capacity
pressure, and `metrics.snapshot()` reports hits, removals, and the reason behind
each removal.
