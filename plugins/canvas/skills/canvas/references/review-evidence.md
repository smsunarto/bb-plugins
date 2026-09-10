# Recover intent and attach evidence

Read this when a Canvas review draws on coding conversations or requirements. Use the current implementation session directly when it contains the evidence. For other sessions, use the installed Traces plugin's read API below. Do not require trace setup to produce a useful source-based review.

## Intent pass

1. Survey the relevant conversation in chronological order before searching for isolated supporting phrases. Include user corrections and observable agent actions or tool results that explain the implementation. Do not quote hidden reasoning.
2. Record requirements, accepted decisions, corrections, reversals, and unresolved questions. Inspect relevant delegated work when the main conversation points to it and it is available.
3. Cross-check each proposed claim against the inspected revision or patch. An assistant proposal is not a user requirement. Label it as an implementation decision unless acceptance is recorded.
4. Put only decisions supported by the final implementation in Summary, Why, and Design. Put superseded decisions only in an optional chronological log, alongside the later reversal.
5. If a trace is missing or incomplete, state the coverage limit and use source-grounded prose. Do not infer missing user intent or scan unrelated sessions.

## Read BB traces

Use structured JSON arguments. Substitute returned IDs, never guessed IDs. If values contain shell metacharacters, invoke the CLI using an argument array rather than interpolating them into shell text.

Resolve the implementation thread:

```sh
bb traces rpc overview '{"threadId":"<bb-thread-id>"}'
```

Use `context.hostId`, `context.provider`, and `context.nativeId`:

```sh
bb traces rpc sessions '{"hostId":"<host>","provider":"<provider>","nativeId":"<native-id>","limit":50}'
```

`items[].id` is the indexed session ID. It differs from the provider's native ID. If `context` is null, the native ID is absent, or no matching session is indexed, continue with the available conversation/source evidence. Do not reconfigure sources or substitute another session.

Survey the ordered event index without `kind`, `topic`, or `query` filters:

```sh
bb traces rpc events '{"hostId":"<host>","sessionId":"<indexed-session-id>","limit":100}'
```

Follow `nextCursor` until null by supplying it as `cursor`. Save bounded pages outside the repository. Summaries support discovery, not exact quotation. Search filters can help on a second pass, but searches cover bounded summaries rather than every raw payload.

Load each event you intend to cite:

```sh
bb traces rpc event '{"hostId":"<host>","eventId":"<event-id>"}'
```

Require `sourceState: "available"`. Read the complete body and confirm the event role. For a text body, quote an exact substring of `body.text`, never `event.preview`. If `bodyTruncated` is true, fetch raw pages:

```sh
bb traces rpc raw '{"hostId":"<host>","eventId":"<event-id>","offset":0,"limit":65536}'
```

Decode `base64` and follow `nextOffset` until null. Check `state` on every page. Use the event's provenance pointer to identify the correct field in the source record. If exact text cannot be recovered, omit the quote. Missing, changed, or unreadable sources are not verified quotations.

Do not silently alter the trace index or configure scanning roots as part of authoring. If the required session is unavailable, report that and proceed with the evidence you have.

## Quote and source contract

- Prefer short exact user quotes for Summary, Why, and requirements. Connect them with minimal prose that does not add unsupported intent.
- Preserve wording and casing. Place explanations, omissions, and corrections outside quotation marks. Do not splice separate turns into one quote.
- Keep a locator next to each quote: speaker, session ID, event ID, and source path/line from `event.provenance`. Use a real event URL only when one is supplied by BB. Do not construct an undocumented trace deep link.
- For current conversation evidence without an event locator, identify it as current-conversation evidence. Never fabricate a session or event ID.
- Design claims should connect a requirement or recorded decision to a source link or inspected excerpt. Verify a source range against the exact revision it names.
- When a source has moved since inspection, retain an embedded snapshot or refresh the claim and citation together. A current local-file link cannot prove a historical claim.

Canvas does not automatically verify transcript substrings or enforce pinned source checkouts. Perform these evidence checks during authoring and state the limits. A successful `bb canvas check` validates MDX and component props only.
