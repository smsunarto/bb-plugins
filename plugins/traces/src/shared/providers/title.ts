import { object } from "./common";

const textTypes = new Set(["text", "input_text", "output_text"]);
const envelopeNames = new Set([
  "recommended_plugins",
  "environment_context",
  "INSTRUCTIONS",
  "system-reminder",
  "skills_instructions",
]);

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((value) => {
      const block = object(value);
      return textTypes.has(String(block.type)) && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function envelopeEnd(text: string): number | null {
  const name = /^<([A-Za-z_-]+)>/.exec(text)?.[1];
  if (!name || !envelopeNames.has(name)) return null;
  let depth = 0;
  for (const match of text.matchAll(new RegExp(`</?${name}>`, "g"))) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return null;
}

function catalogEnd(text: string): number | null {
  const heading = /^#{1,6}[ \t]+Available (?:skills|plugins)[ \t]*\r?\n/i.exec(text);
  if (!heading) return null;
  let end = heading[0].length;
  let entries = 0;
  for (const match of text.slice(end).matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0];
    if (!line.trim()) {
      end += line.length;
      continue;
    }
    if (/^[ \t]*[-*][ \t]+\S/.test(line)) entries += 1;
    else if (!entries || !/^(?: {2,}|\t)\S/.test(line)) break;
    end += line.length;
  }
  return entries ? end : null;
}

function prefixEnd(text: string): number | null {
  const header =
    /^#{1,6}[ \t]+(?:AGENTS|CLAUDE)\.md instructions for [^\r\n]+\r?\n\s*(?=<INSTRUCTIONS>)/.exec(
      text,
    );
  if (header) {
    const end = envelopeEnd(text.slice(header[0].length));
    return end === null ? null : header[0].length + end;
  }
  return envelopeEnd(text) ?? catalogEnd(text);
}

export function userPromptTitle(content: unknown): string | null {
  let text = messageText(content).trimStart();
  while (text) {
    const end = prefixEnd(text);
    if (end === null) break;
    text = text.slice(end).trimStart();
  }
  const title = text.split(/\r?\n/, 1)[0]?.replaceAll("\u0000", "").trim();
  return title ? title.slice(0, 160) : null;
}
