import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  SESSION_MENTION_PROVIDER,
  parseSessionMentionId,
} from "../../shared/contracts/selection-handoff.ts";
import { bbToolName } from "./tools/rename.ts";

/**
 * The pill "Add to chat" puts beside a quote. Only a selection inserts it, so
 * search lists nothing. Resolve reads nothing either: the item id carries the
 * session and version, and a throw here would block the user's send.
 */
export function registerSessionMention(bb: BbPluginApi): void {
  bb.ui.registerMentionProvider({
    id: SESSION_MENTION_PROVIDER,
    label: "Whiteboards",
    search: () => [],
    resolve(itemId) {
      const reference = parseSessionMentionId(itemId);
      if (!reference) throw new Error(`Unknown Whiteboard reference: ${itemId}`);
      const read = JSON.stringify({ ...reference, full: true });
      return {
        context: `The user quoted Whiteboard session ${reference.sessionId}, version ${reference.version}. Read that version with ${bbToolName("session_get")}(${read}).`,
      };
    },
  });
}
