import { experimental_usePluginId, useRealtime } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useRef } from "react";

import {
  COMPLETION_SOUND_PATH,
  WORKSPACE_CHANGED_CHANNEL,
  workspaceChangedSignalSchema,
} from "../shared/contract.ts";

/** Browser-wide Web Lock. The one tab holding it plays the sound. */
const PLAYER_LOCK = "kitchen-sink:completion-sound";
/**
 * Interactions that count as a user gesture in every engine. A tap's
 * pointerdown does not on iOS, so a tap counts at its click.
 */
const GESTURES = ["click", "keydown"] as const;
/** A rising fifth, A5 then E6, for when no Cursor install can lend its sound. */
const CHIME_HZ = [880, 1318.5];

/**
 * Plays a sound when a thread finishes its turn. It plays in the user's
 * browser, not on the bb server, which may be another machine. Mounted
 * app-wide as an overlay that renders nothing.
 *
 * One tab per browser plays. A tab joins the Web Lock election only after the
 * user has interacted with it, because browsers refuse sound to a tab nobody
 * touched. Focus is not required: the sound is for a user who looked away.
 */
export function CompletionSound() {
  const pluginId = experimental_usePluginId();
  const player = useMemo(
    () =>
      completionPlayer(
        `/api/v1/plugins/${encodeURIComponent(pluginId)}/http${COMPLETION_SOUND_PATH}`,
      ),
    [pluginId],
  );
  const elected = usePlayerElection(player);
  useRealtime(WORKSPACE_CHANGED_CHANNEL, (payload) => {
    const parsed = workspaceChangedSignalSchema.safeParse(payload);
    if (
      parsed.success &&
      parsed.data.reason === "idle" &&
      parsed.data.parentThreadId === null &&
      elected.current
    ) {
      void player.play();
    }
  });
  return null;
}

/**
 * True while this tab holds {@link PLAYER_LOCK}. Without Web Locks, every tab
 * plays. Every gesture also unlocks the player if it needs it.
 */
function usePlayerElection(player: CompletionPlayer): { readonly current: boolean } {
  const elected = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let joined = false;
    const join = () => {
      if (joined) return;
      joined = true;
      if (!navigator.locks) {
        elected.current = true;
        return;
      }
      navigator.locks
        .request(
          PLAYER_LOCK,
          { signal },
          () =>
            new Promise<void>((release) => {
              elected.current = true;
              signal.addEventListener("abort", () => release(), { once: true });
            }),
        )
        .catch(() => {});
    };
    const onGesture = () => {
      player.unlock();
      join();
    };
    for (const type of GESTURES) window.addEventListener(type, onGesture, true);
    if (navigator.userActivation?.hasBeenActive ?? true) join();
    return () => {
      for (const type of GESTURES) window.removeEventListener(type, onGesture, true);
      controller.abort();
      player.release();
      elected.current = false;
    };
  }, [player]);
  return elected;
}

interface CompletionPlayer {
  /** Call inside a user gesture. Starts the audio context for later plays. */
  unlock(): void;
  play(): Promise<void>;
  /** Frees the audio device once the tab no longer plays. */
  release(): void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cursor's sound from the server's route, or a synthesized chime once the
 * route has none, both through one AudioContext. Web Audio rather than an
 * audio element, because iOS shows an audio element in Now Playing on the lock
 * screen; WebKit lists an AudioContext there only on a page that set
 * `navigator.audioSession.type` to playback. WebKit starts only a context that
 * a gesture resumed, so the player keeps it and resumes it in each gesture.
 * It is suspended between sounds, so an idle tab holds no audio device.
 */
function completionPlayer(url: string): CompletionPlayer {
  let context: AudioContext | undefined;
  /** Undefined until fetched, null once the route has no sound. */
  let cursor: Promise<AudioBuffer | null> | undefined;
  let sounding = 0;
  const rest = () => {
    if (sounding === 0) void context?.suspend().catch(() => {});
  };
  const cursorSound = (audio: AudioContext) =>
    (cursor ??= fetch(url).then(
      async (response) =>
        response.ok ? audio.decodeAudioData(await response.arrayBuffer()) : null,
      (error: unknown) => {
        // A network failure may pass, so the next play fetches again.
        cursor = undefined;
        throw error;
      },
    ));
  return {
    unlock() {
      if (typeof AudioContext === "undefined") return;
      context ??= new AudioContext();
      if (context.state !== "running") context.resume().then(rest, () => {});
    },
    async play() {
      if (typeof AudioContext === "undefined") return;
      const audio = (context ??= new AudioContext());
      sounding += 1;
      try {
        const buffer = await cursorSound(audio).catch(() => null);
        await Promise.race([audio.resume(), delay(1_000)]);
        // A refusal stays silent until the next gesture resumes the context.
        if (audio.state !== "running") return;
        const start = audio.currentTime;
        if (buffer) {
          const source = audio.createBufferSource();
          source.buffer = buffer;
          source.connect(audio.destination);
          source.start(start);
          await delay(buffer.duration * 1_000 + 100);
          return;
        }
        CHIME_HZ.forEach((frequency, index) => {
          const at = start + index * 0.12;
          const tone = audio.createOscillator();
          const level = audio.createGain();
          tone.frequency.value = frequency;
          level.gain.setValueAtTime(0.0001, at);
          level.gain.exponentialRampToValueAtTime(0.2, at + 0.01);
          level.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
          tone.connect(level).connect(audio.destination);
          tone.start(at);
          tone.stop(at + 0.45);
        });
        await delay(700);
      } catch {
        // Audio unavailable: a missed sound must never surface as an error.
      } finally {
        sounding -= 1;
        rest();
      }
    },
    release() {
      void context?.close().catch(() => {});
      context = undefined;
      cursor = undefined;
    },
  };
}
