import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";

/** Room left for the truncation marker under bb's combined stdout+stderr cap. */
const MARKER_RESERVE_BYTES = 512;

/** Keep a reply under bb's 1 MiB CLI output cap, saying so when it is cut. */
export function capOutput(text: string, maxBytes = PLUGIN_CLI_OUTPUT_MAX_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  // Cut on a UTF-8 boundary: drop continuation bytes at the cut.
  let end = maxBytes - MARKER_RESERVE_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n[Output truncated: ${end} of ${bytes.byteLength} bytes shown. bb caps plugin CLI output at ${maxBytes} bytes; narrow the read to see the rest.]\n`;
}
