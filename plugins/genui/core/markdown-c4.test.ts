import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dataKey, parseDataFile, type LoadedData } from "./data";
import { specToMarkdown } from "./markdown";

/** The markdown of `source` with `files` (gallery/data names) loaded as Load reads them. */
function markdown(source: string, ...files: string[]): string {
  const data = new Map<string, LoadedData>();
  for (const file of files) {
    const path = `data/${file}`;
    data.set(dataKey({ path, raw: false }), parseDataFile(path, readFileSync(new URL(`../gallery/${path}`, import.meta.url), "utf8")));
  }
  return specToMarkdown(source, data);
}

describe("toMarkdown: Transcript", () => {
  it("gives the WER and each error with its time", () => {
    expect(markdown('Transcript(Load("data/transcript/call.json"), "data/transcript/call.wav")', "transcript/call.json")).toBe(
      [
        "**Transcript** · Streaming model (sample errors) against Reference (script): WER 29.6% (3 misheard · 4 missing · 1 extra · 2 with the wrong speaker) · 27 words · 0:16",
        "",
        "- 0:01.4 “can you hear me” heard as “Jeremy”",
        "- 0:04.4 “Yes, I” given to Sam, said by Maya",
        "- 0:06.4 “fine” heard as “find.”",
        "- 0:07.7 extra “so”",
        "- 0:11.2 “let us” heard as “let's”",
        "",
        "Recording: `data/transcript/call.wav`",
      ].join("\n"),
    );
  });

  it("lists each transcript's WER and names the transcript on each error", () => {
    const out = markdown(
      'Transcript([Load("data/transcript/call.json").tracks[0], Load("data/transcript/whisper-cpp-base.en-noisy.json"), Load("data/transcript/whisper-cpp-tiny.en-noisy.json")])',
      "transcript/call.json",
      "transcript/whisper-cpp-base.en-noisy.json",
      "transcript/whisper-cpp-tiny.en-noisy.json",
    );
    expect(out.split("\n").slice(0, 5)).toEqual([
      "**Transcript** · 2 transcripts against Reference (script) · 27 words · 0:16",
      "- whisper.cpp base.en: WER 33.3% (7 misheard · 1 missing · 1 extra)",
      "- whisper.cpp tiny.en: WER 22.2% (6 misheard)",
      "",
      "- 0:01.4 whisper.cpp base.en: “can” heard as “and”",
    ]);
  });

  it("works without times: the user's own example", () => {
    expect(markdown('Transcript([{name: "Said", text: "Hello hello can you hear me speaking"}, {name: "Written", text: "Hello hello Jeremy speaking"}])')).toBe(
      ["**Transcript** · Written against Said: WER 57.1% (1 misheard · 3 missing) · 7 words", "", "- “can you hear me” heard as “Jeremy”"].join("\n"),
    );
  });

  it("shows a lone transcript as its text", () => {
    expect(markdown('Transcript([{name: "Notes", text: "one two three"}])')).toBe(["**Transcript** · Notes · 3 words", "", "> one two three"].join("\n"));
  });

  it("says what is wrong with unusable input", () => {
    expect(markdown('Transcript([{name: "x", foo: 1}])')).toBe("_(track 1 has no words, text or segments)_");
  });
});
