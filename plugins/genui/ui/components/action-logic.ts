// What pressing a control does, for the glyph at its end and its tooltip.
// Only actions that leave the block are named: an answer to the agent, a link,
// a copy. Set only changes the block, where its effect shows anyway.
import type { Action } from "../../core/types";
import type { Answers } from "../runtime";

/** The glyph of each action that leaves the block, by weight: a message, then a link, then a copy. */
const GLYPHS = [
  ["send", "Sent"],
  ["openUrl", "ExternalLink"],
  ["copy", "Copy"],
] as const satisfies readonly (readonly [Action["type"], string])[];

export type ActionGlyph = (typeof GLYPHS)[number][1];

/** Glyphs that name an action: a control draws one only for that action, so it never promises another. */
export const ACTION_GLYPHS: ReadonlySet<string> = new Set(GLYPHS.map(([, glyph]) => glyph));

/** How many characters of a sent or copied text, or of a link, a hint shows. */
const HINT_TEXT_MAX = 200;

/**
 * What pressing does with a control's Send actions (its answer), on the
 * thread's answer sheet (ui/answerSheet.ts): "stage" puts it in the user's
 * message, "send" posts it at once (no composer for the thread on screen),
 * "withdraw" takes the picked answer back out, and "none" skips it (the
 * question is closed, or the control holds no answer).
 */
export type SendEffect = "stage" | "send" | "withdraw" | "none";

/** The SendEffect of an answer control that is `open` (its question not closed) and `picked` (its answer staged), where answers go to `target`. */
export function sendEffect(target: Answers["target"], open: boolean, picked: boolean): SendEffect {
  if (!open) return "none";
  if (picked) return "withdraw";
  return target === "direct" ? "send" : "stage";
}

export interface ActionIntent {
  /** BB's icon for what pressing does; null when it only changes this UI. */
  readonly glyph: ActionGlyph | null;
  /** What pressing does in words, one line per action that leaves this UI; null when none does. */
  readonly hint: string | null;
}

/**
 * What pressing a control running `actions` does, where its Send actions do
 * `send` (skipped unless given). `shown` is the text the control already
 * shows (its label): an answer or copy of that same text is not quoted
 * again, and the hint says where it goes instead. A link is always spelled
 * out, since its label can say anything. Taking a picked answer back out
 * runs nothing else, so it is the only line.
 */
export function actionIntent(actions: readonly Action[], { send = "none", shown }: { send?: SendEffect; shown?: string } = {}): ActionIntent {
  const answers = send !== "none" && actions.some((action) => action.type === "send");
  if (answers && send === "withdraw") return { glyph: "Sent", hint: "Take it out of your message" };
  const glyph = GLYPHS.find(([type]) => (type === "send" ? answers : actions.some((action) => action.type === type)))?.[1] ?? null;
  const visible = shown === undefined ? null : words(shown);
  const lines = actions.flatMap((action) => {
    switch (action.type) {
      case "send":
        if (!answers) return [];
        if (send === "stage") return [words(action.text) === visible ? "Add to your message" : `Add “${clip(action.text)}” to your message`];
        return [words(action.text) === visible ? "Send as your reply" : `Send “${clip(action.text)}”`];
      case "openUrl": {
        const url = openableLink(action.url);
        if (url === null) return [`Can't open ${clip(action.url)}: only http and https links open`];
        // Without a user name and password, as browsers show addresses: `https://github.com@evil.com/` reads `https://evil.com/`.
        url.username = "";
        url.password = "";
        return [`Open ${clip(url.href)}`];
      }
      case "copy":
        return [words(action.text) === visible ? "Copy to the clipboard" : `Copy “${clip(action.text)}”`];
      case "set":
        return [];
    }
  });
  return { glyph, hint: lines.length === 0 ? null : lines.join("\n") };
}

/** `text` as a label reads: whitespace runs as one space, and no closing full stop ("Go with BullMQ." is Decision's "Go with BullMQ"). */
function words(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\.$/, "");
}

/**
 * The address an OpenUrl opens, parsed as the browser does, so punycode and
 * escapes show what it really is; null unless it is an http or https link,
 * which LiveUi refuses to open.
 */
export function openableLink(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
}

/**
 * Where a quoted text breaks a line, the next one is indented, so no line of
 * a sent or copied text reads as another action's (CSS keeps an em space at
 * the start of a line, where it drops a space).
 */
const QUOTED_LINE_BREAK = "\n\u2003\u2003";

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** `text` trimmed and, past HINT_TEXT_MAX characters, cut after a whole word with an ellipsis; its later lines indented. */
function clip(text: string): string {
  // Characters as the reader sees them: a flag or a family emoji is one, never cut in half.
  const characters = Array.from(GRAPHEMES.segment(text.trim()), (part) => part.segment);
  if (characters.length <= HINT_TEXT_MAX) return characters.join("").replaceAll("\n", QUOTED_LINE_BREAK);
  const cut = characters.slice(0, HINT_TEXT_MAX).join("");
  // A cut that falls just before a space already ends on a whole word.
  const space = /\s/.test(characters[HINT_TEXT_MAX]) ? cut.length : cut.search(/\s\S*$/);
  return `${(space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`.replaceAll("\n", QUOTED_LINE_BREAK);
}
