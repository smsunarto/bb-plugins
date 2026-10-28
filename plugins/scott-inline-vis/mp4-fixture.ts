/** Small MP4 files for the media streaming tests. Remuxing copies packets, so they need no real video. */
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";

export const STREAM_TYPE = 'video/mp4; codecs="avc1.640029"';
// The avcC record ffmpeg writes for a 64x64 H.264 High 4.1 clip.
const AVCC = Uint8Array.from(
  "01640029ffe1001867640029acd94426c044000003000400000300183c60c65801000668ebe3cb22c0fdf8f800".match(
    /../g,
  )!,
  (byte) => Number.parseInt(byte, 16),
);

/** Six packets, a key frame every three. `fastStart: false` puts the index after the media. */
export async function mp4File(fastStart: false | "in-memory" | "fragmented"): Promise<Uint8Array> {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target });
  const source = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(source);
  await output.start();
  for (let index = 0; index < 6; index++) {
    const packet = new EncodedPacket(
      Uint8Array.from([0, 0, 0, 1, index]),
      index % 3 === 0 ? "key" : "delta",
      index / 3,
      1 / 3,
    );
    await source.add(
      packet,
      index === 0
        ? {
            decoderConfig: {
              codec: "avc1.640029",
              codedWidth: 64,
              codedHeight: 64,
              description: AVCC,
            },
          }
        : undefined,
    );
  }
  source.close();
  await output.finalize();
  return new Uint8Array(target.buffer!);
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

/**
 * A Blob's text. Under jsdom, Node 24's `Response.blob()` builds jsdom's Blob,
 * which has no `text()`; Node 22's returns Node's own Blob, which jsdom's
 * FileReader refuses.
 */
export function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(blob);
  });
}
