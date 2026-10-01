/**
 * Port of upstream `mcpAuthoringGuidance` (`review-api/mcp.ts:28-46` @4ecc570),
 * prefixed to the `whiteboard_session_get_instructions` description (design
 * §3.5). The sentences are upstream's, byte for byte; the agent boundary
 * renames their `session_x` tokens. `guidance.test.ts` evaluates the upstream
 * function source and compares every input combination.
 */
export function mcpAuthoringGuidance(context: {
  scratchpadAvailable: boolean;
  traceEnabled: boolean;
}): string {
  return [
    "Whiteboard explains code in documents the user reads in Whiteboard Desktop. Call session_get_instructions before creating or editing a Whiteboard and follow it. Read session_capabilities before authoring; session_create opens the new review in Desktop when it is available, so call session_open only for an existing review, and generate software maps only when softwareMapEnabled is true. When the user asks for a Whiteboard or to use Whiteboard (for example to review a branch, a change or a pull request, or to explain a system in Whiteboard), author a Whiteboard with the default topic.",
    ...(context.scratchpadAvailable
      ? [
          'When the user asks in conversation to be shown how code works or wants a diagram, without asking for a Whiteboard, call session_capabilities; if it reports scratchpadEnabled and desktopAvailable, draw on the Whiteboard scratchpad rather than answering only in chat, starting with session_get_instructions({topic:"scratchpad"}).',
        ]
      : []),
    ...(context.traceEnabled
      ? [
          'For why code exists, what an agent was thinking, or whether an agent solved something before, call session_get_instructions({topic:"trace-archaeology"}).',
        ]
      : []),
    "Never read or write Whiteboard files or SQL. Reuse commandId and identical input after a lost response.",
  ].join(" ");
}
