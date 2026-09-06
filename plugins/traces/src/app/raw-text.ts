export function decodeRawPage(base64: string, offset: number, final: boolean) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  let start = 0;
  if (offset > 0)
    while (start < Math.min(3, bytes.length) && (bytes[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start), { stream: !final });
}
