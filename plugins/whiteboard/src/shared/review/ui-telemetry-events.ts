// bb sends no telemetry. What remains is what the review API still reads:
// the agent kind a request names and the app session header CORS allows.

/** The authoring agent a review session is attributed to. */
export const SESSION_AGENT_KIND = ["codex", "claude", "pi", "other"] as const;

export type ReviewSessionAgent = (typeof SESSION_AGENT_KIND)[number];

/**
 * Header the canvas app attaches to review API requests so server-side events
 * can share the UI session id. The CORS preflight allowlist in
 * server/hono-http.ts must permit every header named here — the canvas runs on
 * a vscode-file:// origin, so a header missing from that list fails the
 * preflight and takes the whole request down with it.
 */
export const REVIEW_APP_SESSION_ID_HEADER = "x-review-app-session-id";
