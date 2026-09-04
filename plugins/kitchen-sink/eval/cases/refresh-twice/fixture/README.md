# auth-middleware

Session authentication for the edge service. `requireSession` pulls a session id
off the request, answers 401 when it is missing or unknown, and hands a resolved
session to the wrapped handler.

Access tokens are short lived, so `refreshSession` rotates them against the
identity provider and holds the result for a moment, which keeps a burst of
requests for the same session down to one round trip. Records live in memory
here; the hosted provider swaps in at `rotate`.

Run `bun run start` to serve it on `PORT`.
