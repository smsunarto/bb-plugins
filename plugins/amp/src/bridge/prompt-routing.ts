/**
 * `src/bridge/prompt-routing.ts` — the `/orb` execution-target directive.
 *
 * Ported from the ACP bridge's `routeAmpPrompt` (bridge-core.ts, removed in
 * 3607ed7; the migration dropped this parse and with it the whole Orb
 * trigger). Only the first non-generated text block of a turn's input may
 * route: bb keeps block order, generated instructions lead the prompt, and
 * plugin context follows the main text. bb framing and attachments may
 * contain the same bytes and must never change execution — natively that is
 * the `agent-only` visibility plus the text patterns below.
 */
import type { AmpExecutionTarget } from "../execution-target.ts";
import { stripOrbDirectives } from "../orb-directive.ts";

export interface RoutedAmpPrompt {
  /** The prompt text Amp receives: text blocks joined with a blank line
   * (`promptText` parity), directive tokens removed. */
  prompt: string;
  requestedTarget: AmpExecutionTarget | null;
  /** True when stripping the directive left no instructions in its block. */
  directiveOnly: boolean;
}

const BB_SYSTEM_INSTRUCTIONS_PATTERN =
  /^<system_instructions>\n[\s\S]*\n<\/system_instructions>$/u;
const BB_ATTACHMENT_PLACEHOLDER_PATTERN =
  /^\[(?:image attachment|image attachment on disk|unreadable image attachment): [\s\S]*\]$/u;
const BB_PLUGIN_CONTEXT_PATTERN = /^Context for @[\s\S]+ \(resolved by plugin "[^"]+"\):\n\n/u;
const BB_AGENT_MESSAGE_PATTERN = /^\[bb message from thread:[^\]]+\]\n\n/u;
const BB_SYSTEM_MESSAGE_PATTERN = /^\[bb system\]\n\n/u;

function isBbDirectiveIneligibleText(text: string): boolean {
  return (
    BB_ATTACHMENT_PLACEHOLDER_PATTERN.test(text) ||
    BB_PLUGIN_CONTEXT_PATTERN.test(text) ||
    BB_AGENT_MESSAGE_PATTERN.test(text) ||
    BB_SYSTEM_MESSAGE_PATTERN.test(text) ||
    text === "Please continue."
  );
}

interface TextBlock {
  text: string;
  agentOnly: boolean;
}

/** The wire schema validated `input` upstream; this projects the text blocks
 * structurally, exactly like `promptText` before it. Image and file blocks
 * carry no text and never route. */
function textBlocks(input: readonly unknown[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const block of input) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") continue;
    blocks.push({ text: record.text, agentOnly: record.visibility === "agent-only" });
  }
  return blocks;
}

export function routeAmpPrompt(input: readonly unknown[]): RoutedAmpPrompt {
  const parts: string[] = [];
  let requestedTarget: AmpExecutionTarget | null = null;
  let directiveOnly = false;
  let directiveCandidateResolved = false;
  for (const [index, block] of textBlocks(input).entries()) {
    let stripped = block.text;
    const isLeadingInstructions = index === 0 && BB_SYSTEM_INSTRUCTIONS_PATTERN.test(block.text);
    if (!directiveCandidateResolved && !isLeadingInstructions && !block.agentOnly) {
      directiveCandidateResolved = true;
      if (!isBbDirectiveIneligibleText(block.text)) {
        const routed = stripOrbDirectives(block.text);
        stripped = routed.text;
        if (routed.found) {
          requestedTarget = "orb";
        }
        directiveOnly = requestedTarget !== null && stripped.trim().length === 0;
      }
    }
    parts.push(stripped);
  }
  return {
    prompt: parts.join("\n\n"),
    requestedTarget,
    directiveOnly,
  };
}
