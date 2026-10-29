import { fill, instructionFiles } from "@bb-plugins/instructions";

const instructions = instructionFiles(import.meta.url);

// Strip controls from plugin-provided display text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const WHITESPACE = /\s+/gu;

export const MAX_CONTEXT_BYTES = 1_024;
export const MAX_IDENTITY_BYTES = 256;
export const MAX_ITEM_TITLE_BYTES = 120;
export const MAX_ITEM_SUBTITLE_BYTES = 240;

const MAX_CONTEXT_FIELD_BYTES = 512;

export interface InstalledMentionIdentity {
  pluginId: string;
}

export interface InstalledPluginReference extends InstalledMentionIdentity {
  name: string;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  if (utf8ByteLength(value) <= maxBytes) return value;

  let bytes = 0;
  let result = "";
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (bytes + codePointBytes > maxBytes) break;
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

export function normalizeUntrustedText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
}

export function boundUntrustedText(value: string, maxBytes: number): string {
  return truncateUtf8(normalizeUntrustedText(value), maxBytes).trimEnd();
}

export function normalizeStableIdentity(value: string): string | null {
  const normalized = normalizeUntrustedText(value);
  if (normalized.length === 0 || utf8ByteLength(normalized) > MAX_IDENTITY_BYTES) {
    return null;
  }
  return normalized;
}

function encodeIdentitySegment(value: string): string {
  const normalized = normalizeStableIdentity(value);
  if (normalized === null) throw new Error("Invalid plugin mention identity");
  return encodeURIComponent(normalized);
}

function decodeIdentitySegment(value: string): string {
  if (value.length === 0) throw new Error("Invalid plugin mention identity");

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("Invalid plugin mention identity");
  }

  const normalized = normalizeStableIdentity(decoded);
  if (normalized === null || normalized !== decoded || encodeURIComponent(decoded) !== value) {
    throw new Error("Invalid plugin mention identity");
  }
  return decoded;
}

export function encodeInstalledItemId(pluginId: string): string {
  return encodeIdentitySegment(pluginId);
}

export function decodeInstalledItemId(itemId: string): InstalledMentionIdentity {
  if (itemId.includes(":")) throw new Error("Invalid Installed plugin mention identity");
  return { pluginId: decodeIdentitySegment(itemId) };
}

function requireContextField(value: string): string {
  const normalized = boundUntrustedText(value, MAX_CONTEXT_FIELD_BYTES);
  if (normalized.length === 0) throw new Error("Invalid plugin reference metadata");
  return normalized;
}

function removeLastCodePoint(value: string): string {
  const codePoints = Array.from(value);
  codePoints.pop();
  return codePoints.join("").trimEnd();
}

function renderBoundedContext(
  rawFields: Readonly<Record<string, string>>,
  render: (fields: Readonly<Record<string, string>>) => string,
): string {
  const fields: Record<string, string> = Object.fromEntries(
    Object.entries(rawFields).map(([key, value]) => [key, requireContextField(value)]),
  );

  let context = render(fields);
  while (utf8ByteLength(context) > MAX_CONTEXT_BYTES) {
    const candidate = Object.keys(fields)
      .filter((key) => key === "name" && Array.from(fields[key]!).length > 1)
      .sort(
        (left, right) =>
          utf8ByteLength(JSON.stringify(fields[right])) -
          utf8ByteLength(JSON.stringify(fields[left])),
      )[0];

    if (candidate === undefined) {
      throw new Error(
        "instructions/installed-plugin.md is too long. Shorten it in Agent instructions → Plugin prompts, then retry, or remove the plugin mention.",
      );
    }

    fields[candidate] = removeLastCodePoint(fields[candidate]!);
    context = render(fields);
  }

  return context;
}

export function buildInstalledPluginContext(reference: InstalledPluginReference): string {
  const template = instructions.read("installed-plugin");
  return renderBoundedContext(
    { name: reference.name, pluginId: reference.pluginId },
    ({ name, pluginId }) => {
      try {
        return fill(template, {
          name: JSON.stringify(name),
          pluginId: JSON.stringify(pluginId),
        });
      } catch (error) {
        throw new Error(`instructions/installed-plugin.md: ${String(error)}`, { cause: error });
      }
    },
  );
}
