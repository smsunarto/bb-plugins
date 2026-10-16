/** Byte-level MP4 fixtures for the media streaming tests. */
export const STREAM_TYPE = 'video/mp4; codecs="avc1.640029,mp4a.40.2"';
export const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
export const zeros = (length: number) => Array<number>(length).fill(0);
export const bytes = (...parts: ArrayLike<number>[]) =>
  Uint8Array.from(parts.flatMap((part) => Array.from(part)));
export function box(type: string, ...payload: ArrayLike<number>[]) {
  const body = bytes(...payload);
  const size = new DataView(new ArrayBuffer(4));
  size.setUint32(0, 8 + body.length);
  return bytes(new Uint8Array(size.buffer), ascii(type), body);
}
/** An ffmpeg-shaped init segment with H.264 High 4.1 video and AAC-LC audio. */
export function mp4Init({ fragmented = true } = {}) {
  const avc1 = box("avc1", zeros(78), box("avcC", [1, 0x64, 0x00, 0x29]));
  // ES descriptor > decoder config (MPEG-4 audio) > decoder specific info (object type 2).
  const esds = box(
    "esds",
    zeros(4),
    [0x03, 0x16, 0, 1, 0, 0x04, 0x11, 0x40, 0x15],
    zeros(11),
    [0x05, 0x02, 0x12, 0x10],
  );
  const trak = (entry: Uint8Array) =>
    box("trak", box("mdia", box("minf", box("stbl", box("stsd", zeros(4), [0, 0, 0, 1], entry)))));
  return bytes(
    box("ftyp", ascii("isom"), zeros(4)),
    box(
      "moov",
      box("mvhd", zeros(100)),
      trak(avc1),
      trak(box("mp4a", zeros(28), esds)),
      fragmented ? box("mvex", box("trex", zeros(24))) : [],
    ),
  );
}

export function chunkedResponse(chunks: Uint8Array[], type = "video/mp4") {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": type } });
}
