import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, canEncodeVideo } from "mediabunny";
import {
  frameCount,
  frameTime,
  parseShotScript,
  type ModelEvidenceInput,
  type ShotScript,
} from "../../shared/model-review.ts";
import type { ReviewEngine } from "./engine.ts";

export type CaptureResult = { runId: string; files: string[] };
export async function captureShots(
  engine: ReviewEngine,
  raw: unknown,
  model: string,
  gameId: string,
  save: (input: ModelEvidenceInput) => Promise<CaptureResult>,
  progress: (message: string) => void,
  signal: AbortSignal,
): Promise<CaptureResult> {
  const script = parseShotScript(raw);
  if (!engine.selfContained)
    throw new Error(
      "Evidence needs a self-contained model. Export it as a GLB or embed its buffers and textures.",
    );
  const available = engine.stats;
  // Reject the entire script before writing its first capture.
  for (const shot of script.shots) {
    if (shot.animation && !available.clips.some((clip) => clip.name === shot.animation!.clip))
      throw new Error(`Unknown animation ${shot.animation.clip}`);
    engine.view(shot);
  }
  if (
    script.shots.some((shot) => shot.video) &&
    !(await canEncodeVideo("avc", { width: script.width, height: script.height }))
  )
    throw new Error(
      "This browser cannot encode H.264. Open the viewer in a WebCodecs-capable Chrome browser.",
    );
  const runId = crypto.randomUUID();
  engine.resize(script.width, script.height);
  try {
    for (const shot of script.shots) {
      signal.throwIfAborted();
      engine.view(shot);
      let blob: Blob;
      if (shot.video) {
        blob = await encodeVideo(engine, { name: shot.name, video: shot.video }, progress, signal);
      } else {
        engine.renderAt(0);
        blob = await engine.png();
      }
      if (blob.size > 25 * 1024 * 1024)
        throw new Error(
          "Capture exceeds 25 MiB. Reduce duration, resolution, or split the recording.",
        );
      signal.throwIfAborted();
      progress(`Saving ${shot.name}…`);
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1]!), {
          once: true,
        });
        reader.addEventListener("error", () => reject(reader.error), { once: true });
        reader.readAsDataURL(blob);
      });
      await save({
        action: "file",
        gameId,
        runId,
        name: `${shot.name}.${shot.video ? "mp4" : "png"}`,
        content,
      });
    }
    signal.throwIfAborted();
    const finish = {
      action: "finish" as const,
      gameId,
      runId,
      model,
      modelSha256: engine.modelSha256,
      script,
    };
    // Finishing is idempotent, so a lost response or a busy manifest is retried rather than
    // leaving every rendered capture outside Evidence.
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await save(finish);
        progress(`Saved ${result.files.length} captures to Evidence`);
        return result;
      } catch (error) {
        if (attempt === 3 || /Model changed|different/.test(String(error))) throw error;
        progress("Retrying Evidence update…");
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  } finally {
    engine.resize();
  }
}

async function encodeVideo(
  engine: ReviewEngine,
  shot: { name: string; video: NonNullable<ShotScript["shots"][number]["video"]> },
  progress: (message: string) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const { fps, turntable } = shot.video;
  const count = frameCount(shot.video);
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target,
  });
  const video = new CanvasSource(engine.renderer.domElement, {
    codec: "avc",
    bitrate: 4_000_000,
  });
  output.addVideoTrack(video, { frameRate: fps });
  try {
    await output.start();
    for (let frame = 0; frame < count; frame++) {
      signal.throwIfAborted();
      engine.renderAt(frameTime(frame, fps), turntable ? (frame / count) * Math.PI * 2 : 0);
      await video.add(frameTime(frame, fps), 1 / fps);
      if (frame % fps === 0) progress(`${shot.name}: ${frame + 1}/${count} frames`);
    }
    await output.finalize();
    if (!target.buffer) throw new Error("Video encoder returned no output");
    return new Blob([target.buffer], { type: "video/mp4" });
  } catch (error) {
    await output.cancel();
    throw error;
  }
}
