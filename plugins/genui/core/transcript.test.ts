import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataFile } from "./data";
import {
  align,
  autoScale,
  laneIndex,
  tickStep,
  visibleSlice,
  analyse,
  columns,
  countsText,
  describeRegion,
  formatClock,
  formatWer,
  parseClock,
  placeTracks,
  readTracks,
  tokenize,
  type Track,
} from "./transcript";
import type { Value } from "./types";

function gallery(name: string): Value {
  const path = `data/transcript/${name}`;
  const loaded = parseDataFile(path, readFileSync(new URL(`../gallery/${path}`, import.meta.url), "utf8"));
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

function tracks(value: Value): readonly Track[] {
  const read = readTracks(value);
  if (!read.ok) throw new Error(read.error);
  return read.tracks;
}

const keys = (text: string) => tokenize(text.split(" ").map((word) => ({ text: word }))).map((token) => token.key);

describe("tokenize", () => {
  it("ignores case and punctuation, splits hyphens, drops apostrophes", () => {
    expect(keys("Hello, hello! Well-known don't “Quote”")).toEqual(["hello", "hello", "well", "known", "dont", "quote"]);
  });

  it("reads spoken numbers as the digits a recogniser writes", () => {
    expect(keys("twenty five")).toEqual(["25"]);
    expect(keys("one hundred and five")).toEqual(["105"]);
    expect(keys("two thousand twenty four")).toEqual(["2024"]);
    expect(keys("twenty twenty four")).toEqual(["2024"]);
    expect(keys("nineteen forty nine")).toEqual(["1949"]);
    expect(keys("19:49")).toEqual(["1949"]);
    expect(keys("nine oh five")).toEqual(["905"]);
    expect(keys("9:05")).toEqual(["905"]);
    expect(keys("1,000 one thousand")).toEqual(["1000", "1000"]);
    expect(keys("50% fifty percent")).toEqual(["50", "percent", "50", "percent"]);
    expect(keys("twenty first 21st")).toEqual(["21th", "21th"]);
    expect(keys("3.5")).toEqual(["3.5"]);
  });

  it("keeps a list of single digits apart", () => {
    expect(keys("one two three")).toEqual(["1", "2", "3"]);
  });

  it("maps every token back to the words it came from", () => {
    expect(tokenize([{ text: "at" }, { text: "twenty" }, { text: "five" }, { text: "past-nine" }])).toEqual([
      { key: "at", from: 0, to: 0 },
      { key: "25", from: 1, to: 2 },
      { key: "past", from: 3, to: 3 },
      { key: "9", from: 3, to: 3 },
    ]);
  });

  it("drops words with no letters or digits", () => {
    expect(keys("— hello …")).toEqual(["hello"]);
  });
});

describe("align", () => {
  const tokens = (text: string) => tokenize(text.split(" ").map((word) => ({ text: word })));

  it("finds the fewest substitutions, deletions and insertions", () => {
    const ops = align(tokens("hello hello can you hear me speaking"), tokens("hello hello jeremy speaking"));
    const kinds = ops.map((op) => op.kind);
    expect(kinds.filter((kind) => kind === "match")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "sub")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "del")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "ins")).toHaveLength(0);
    expect(ops[0]).toEqual({ kind: "match", ref: 0, hyp: 0 });
    expect(ops[ops.length - 1]).toEqual({ kind: "match", ref: 6, hyp: 3 });
  });

  it("aligns empty sides as all deletions or all insertions", () => {
    expect(align(tokens("a b"), [])).toEqual([
      { kind: "del", ref: 0, hyp: null },
      { kind: "del", ref: 1, hyp: null },
    ]);
    expect(align([], tokens("a"))).toEqual([{ kind: "ins", ref: null, hyp: 0 }]);
  });

  it("puts a substitution on the word said at that time when both are timed", () => {
    const ref = tokens("a b c");
    const hyp = tokens("x");
    // x was said where c was: pair it with c, not a.
    const middle = [0.5, 1.5, 2.5];
    const ops = align(ref, hyp, (r) => Math.min(1, Math.abs(middle[r] - 2.5) / 2));
    expect(ops).toEqual([
      { kind: "del", ref: 0, hyp: null },
      { kind: "del", ref: 1, hyp: null },
      { kind: "sub", ref: 2, hyp: 0 },
    ]);
  });

  it("aligns a 70-minute transcript (10,000+ words) exactly through unique anchors", () => {
    const vocabulary = Array.from({ length: 4000 }, (_, index) => `w${index}`);
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ref = Array.from({ length: 12_000 }, () => vocabulary[Math.floor(random() * vocabulary.length)]);
    const hyp = [...ref];
    hyp.splice(9000, 3); // 3 deletions
    hyp.splice(5000, 1, "zzz"); // 1 substitution
    hyp.splice(100, 0, "extra", "extra"); // 2 insertions
    const started = performance.now();
    const ops = align(tokenize(ref.map((text) => ({ text }))), tokenize(hyp.map((text) => ({ text }))));
    expect(performance.now() - started).toBeLessThan(5000);
    const count = (kind: string) => ops.filter((op) => op.kind === kind).length;
    expect([count("sub"), count("del"), count("ins")]).toEqual([1, 3, 2]);
    expect(count("match")).toBe(12_000 - 4);
  });

  it("falls back to a band when a long input has no unique words", () => {
    const ref = Array.from({ length: 5000 }, (_, index) => (index % 2 === 0 ? "la" : "di"));
    const hyp = [...ref];
    hyp.splice(2500, 2);
    const ops = align(tokenize(ref.map((text) => ({ text }))), tokenize(hyp.map((text) => ({ text }))));
    expect(ops.filter((op) => op.kind !== "match")).toHaveLength(2);
  });
});

describe("readTracks", () => {
  it("reads the gallery call: reference with exact times and speakers, a hypothesis with confidences", () => {
    const [reference, hypothesis] = tracks(gallery("call.json"));
    expect(reference.name).toBe("Reference (script)");
    expect(reference.words).toHaveLength(30);
    expect(reference.timing).toBe("word");
    expect(reference.words[0]).toEqual({ text: "Hello", start: 0.3, end: 0.81, timing: "word", window: null, speaker: "Sam", confidence: null });
    expect(hypothesis.name).toBe("Streaming model (sample errors)");
    expect(hypothesis.words[2].text).toBe("Jeremy");
    expect(hypothesis.words[2].confidence).toBe(0.41);
  });

  it("reads whisper.cpp -ojf output: words from tokens, offsets in ms, the model as the name", () => {
    const [track] = tracks(gallery("whisper-cpp-base.en.json"));
    expect(track.name).toBe("whisper.cpp base.en");
    expect(track.source).toBe("whisper.cpp");
    expect(track.detail).toBe("en");
    expect(track.words.slice(0, 3).map((word) => [word.text, word.start, word.end])).toEqual([
      ["Hello,", 0.33, 0.79],
      ["hello,", 0.91, 1.63],
      ["can", 1.64, 2],
    ]);
    expect(track.words.map((word) => word.text).join(" ")).toBe(
      "Hello, hello, can you hear me speaking? Yes, I can hear you fine. Great, we have 25 minutes. Then, let us look at the transcript at 1949.",
    );
  });

  it("reads whisper.cpp -ml 1 output (one word per entry) as timed words", () => {
    const [track] = tracks({
      params: { model: "models/ggml-tiny.en.bin" },
      result: { language: "en" },
      transcription: [
        { timestamps: { from: "00:00:00,000", to: "00:00:00,330" }, offsets: { from: 0, to: 330 }, text: "" },
        { timestamps: { from: "00:00:00,330", to: "00:00:01,000" }, offsets: { from: 330, to: 1000 }, text: " hello" },
        { timestamps: { from: "00:00:01,000", to: "00:00:04,000" }, offsets: { from: 1000, to: 4000 }, text: " can you see" },
      ],
    });
    expect(track.name).toBe("whisper.cpp tiny.en");
    expect(track.words.map((word) => [word.text, word.start, word.end, word.timing])).toEqual([
      ["hello", 0.33, 1, "word"],
      ["can", 1, 2, "segment"],
      ["you", 2, 3, "segment"],
      ["see", 3, 4, "segment"],
    ]);
    expect(track.words[1].window).toEqual({ start: 1, end: 4 });
  });

  it("reads openai-whisper JSON (here mlx-whisper's, the same writer) with word timestamps", () => {
    const [track] = tracks(gallery("mlx-whisper-tiny.en-noisy.json"));
    expect(track.source).toBe("whisper");
    expect(track.detail).toBe("en");
    expect(track.words[0]).toMatchObject({ text: "Hello,", start: 0, end: 0.64, timing: "word" });
    expect(track.words[0].confidence).toBeCloseTo(0.0625, 4);
    expect(track.words).toHaveLength(27);
  });

  it("reads WhisperX segments with speakers on segments and words", () => {
    const [track] = tracks({
      segments: [
        { start: 0.1, end: 1.2, text: " Hi there", speaker: "SPEAKER_00", words: [{ word: "Hi", start: 0.1, end: 0.4, score: 0.9 }, { word: "there", start: 0.5, end: 1.2, score: 0.8, speaker: "SPEAKER_01" }] },
      ],
      word_segments: [],
    });
    expect(track.words.map((word) => [word.text, word.speaker, word.confidence])).toEqual([
      ["Hi", "SPEAKER_00", 0.9],
      ["there", "SPEAKER_01", 0.8],
    ]);
  });

  it("reads whisper segments without word timestamps as segment-timed words", () => {
    const [track] = tracks({ text: "ab cd", segments: [{ id: 0, start: 2, end: 4, text: " ab cd" }], language: "en" });
    expect(track.timing).toBe("segment");
    expect(track.words.map((word) => [word.text, word.start, word.end])).toEqual([
      ["ab", 2, 3],
      ["cd", 3, 4],
    ]);
  });

  it("reads Deepgram's nested words with numbered speakers", () => {
    const [track] = tracks({
      metadata: { model_info: { "1abc": { name: "general-nova-3", version: "2024" } } },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "hello there",
                words: [
                  { word: "hello", start: 0.08, end: 0.4, confidence: 0.99, speaker: 0, punctuated_word: "Hello" },
                  { word: "there", start: 0.4, end: 0.8, confidence: 0.97, speaker: 1, punctuated_word: "there." },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(track.name).toBe("Deepgram general-nova-3");
    expect(track.words.map((word) => [word.text, word.start, word.speaker])).toEqual([
      ["Hello", 0.08, "Speaker 0"],
      ["there.", 0.4, "Speaker 1"],
    ]);
  });

  it("reads AssemblyAI words in milliseconds with lettered speakers", () => {
    const [track] = tracks({
      audio_duration: 3,
      words: [
        { text: "Hello", start: 250, end: 650, confidence: 0.97, speaker: "A" },
        { text: "world.", start: 730, end: 1100, confidence: 0.99, speaker: "B" },
      ],
    });
    expect(track.name).toBe("AssemblyAI");
    expect(track.words.map((word) => [word.start, word.end, word.speaker])).toEqual([
      [0.25, 0.65, "Speaker A"],
      [0.73, 1.1, "Speaker B"],
    ]);
  });

  it("reads whisper's .tsv rows (start, end in ms) as segments", () => {
    const loaded = parseDataFile("call.tsv", "start\tend\ttext\n330\t4200\tHello, hello, can you hear me speaking?\n4200\t7700\tYes, I can hear you fine.\n");
    if (!loaded.ok) throw new Error(loaded.error);
    const [track] = tracks(loaded.value);
    expect(track.source).toBe("rows");
    expect(track.timing).toBe("segment");
    expect(track.words[0]).toMatchObject({ text: "Hello,", start: 0.33 });
    expect(track.words[track.words.length - 1]).toMatchObject({ text: "fine.", end: 7.7 });
  });

  it("reads SRT and WebVTT text, with WebVTT voices as speakers", () => {
    const [srt] = tracks("1\n00:00:00,330 --> 00:00:04,200\nHello, hello, can you\nhear me speaking?\n\n2\n00:00:04,200 --> 00:00:07,700\nYes.\n");
    expect(srt.source).toBe("subtitles");
    expect(srt.words.map((word) => word.text)).toEqual(["Hello,", "hello,", "can", "you", "hear", "me", "speaking?", "Yes."]);
    expect(srt.words[7]).toMatchObject({ start: 4.2, end: 7.7, timing: "word" });
    const [vtt] = tracks("WEBVTT\n\n00:01.000 --> 00:02.500\n<v Maya>Yes I can</v>\n\n00:02.500 --> 00:03.000 align:start\n<v.loud Sam>Great\n");
    expect(vtt.words.map((word) => [word.text, word.speaker])).toEqual([
      ["Yes", "Maya"],
      ["I", "Maya"],
      ["can", "Maya"],
      ["Great", "Sam"],
    ]);
    expect(vtt.words[0]).toMatchObject({ start: 1, timing: "segment" });
  });

  it("takes {name, text} as an untimed track and names unnamed tracks", () => {
    const read = tracks([{ words: [{ text: "a", start: 0, end: 1 }] }, { text: "a b" }, "c d"]);
    expect(read.map((track) => [track.name, track.timing, track.source])).toEqual([
      ["Reference", "word", "words"],
      ["Transcript 2", "none", "text"],
      ["Transcript 3", "none", "text"],
    ]);
  });

  it("takes a tool's JSON as a track's words, and a bare word list as one track", () => {
    const [named] = tracks([{ name: "Mine", words: { transcription: [{ offsets: { from: 0, to: 500 }, text: " hi" }] } }]);
    expect(named).toMatchObject({ name: "Mine", source: "whisper.cpp" });
    const single = tracks([{ word: "hi", start: 0.1, end: 0.3 }, { word: "you", start: 0.4, end: 0.6 }]);
    expect(single).toHaveLength(1);
    expect(single[0].words).toHaveLength(2);
  });

  it("leaves words with impossible times untimed and says how many", () => {
    const [track] = tracks([{ name: "x", words: [{ text: "a", start: 2, end: 1 }, { text: "b", start: 3, end: 4 }] }]);
    expect(track.words[0].timing).toBe("none");
    expect(track.untimed).toBe(1);
  });

  it("refuses input with nothing to read", () => {
    expect(readTracks(undefined).ok).toBe(false);
    expect(readTracks([{ name: "x", foo: 1 }])).toEqual({ ok: false, error: "track 1 has no words, text or segments" });
    expect(readTracks([])).toEqual({ ok: true, tracks: [] });
  });
});

describe("analyse", () => {
  it("scores the gallery call: “can you hear me” heard as “Jeremy”, a missing word, an extra, a speaker swap", () => {
    const analysis = analyse(tracks(gallery("call.json")))!;
    const [comparison] = analysis.comparisons;
    expect(analysis.refTokens).toHaveLength(27);
    expect(comparison.counts).toEqual({ words: 27, hits: 20, substitutions: 3, deletions: 4, insertions: 1, speaker: 2 });
    expect(formatWer(comparison.wer!)).toBe("29.6%");
    expect(countsText(comparison.counts)).toBe("3 misheard · 4 missing · 1 extra · 2 with the wrong speaker");
    expect(analysis.regions.map(describeRegion)).toEqual([
      "“can you hear me” heard as “Jeremy”",
      "“Yes, I” given to Sam, said by Maya",
      "“fine” heard as “find.”",
      "extra “so”",
      "“let us” heard as “let's”",
    ]);
    expect(analysis.regions[0]).toMatchObject({ kind: "sub", start: 1.46, end: 3.293 });
    expect(comparison.speakerMap).toEqual(
      new Map([
        ["Sam", "Sam"],
        ["Maya", "Maya"],
      ]),
    );
  });

  it("finds no errors in whisper.cpp's real output once numbers and punctuation are normalised", () => {
    const reference = tracks(gallery("call.json"))[0];
    const [whisper] = tracks(gallery("whisper-cpp-base.en.json"));
    const analysis = analyse([reference, whisper])!;
    expect(analysis.comparisons[0].counts).toMatchObject({ substitutions: 0, deletions: 0, insertions: 0, speaker: null });
    expect(analysis.comparisons[0].wer).toBe(0);
  });

  it("scores real recogniser errors on the noisy recording", () => {
    const reference = tracks(gallery("call.json"))[0];
    const analysis = analyse([reference, ...tracks(gallery("whisper-cpp-base.en-noisy.json")), ...tracks(gallery("whisper-cpp-tiny.en-noisy.json"))])!;
    expect(analysis.comparisons.map((comparison) => [analysis.tracks[comparison.track].name, formatWer(comparison.wer!), countsText(comparison.counts)])).toEqual([
      ["whisper.cpp base.en", "33.3%", "7 misheard · 1 missing · 1 extra"],
      ["whisper.cpp tiny.en", "22.2%", "6 misheard"],
    ]);
    expect(analysis.regions.filter((region) => region.track === 1).map(describeRegion)).toEqual([
      "“can” heard as “and”",
      "“hear me speaking” heard as “dare to be seated.”",
      "“Great we have” heard as “Greatly and”",
      "“minutes” heard as “million.”",
    ]);
  });

  it("maps differently named speakers onto the reference's before counting mismatches", () => {
    const analysis = analyse(
      tracks([
        { name: "ref", words: [{ text: "a", speaker: "Ana" }, { text: "b", speaker: "Ana" }, { text: "c", speaker: "Bo" }, { text: "d", speaker: "Bo" }] },
        { name: "hyp", words: [{ text: "a", speaker: "SPEAKER_00" }, { text: "b", speaker: "SPEAKER_00" }, { text: "c", speaker: "SPEAKER_00" }, { text: "d", speaker: "SPEAKER_01" }] },
      ]),
    )!;
    const [comparison] = analysis.comparisons;
    expect(comparison.speakerMap.get("SPEAKER_00")).toBe("Ana");
    expect(comparison.speakerMap.get("SPEAKER_01")).toBe("Bo");
    expect(comparison.counts.speaker).toBe(1);
    expect(describeRegion(analysis.regions[0])).toBe("“c” given to Ana, said by Bo");
  });

  it("counts nothing for speakers when only one side names them", () => {
    const analysis = analyse(tracks([{ name: "r", words: [{ text: "a", speaker: "X" }] }, { name: "h", text: "a" }]))!;
    expect(analysis.comparisons[0].counts.speaker).toBeNull();
  });

  it("says when the whole opening sentence is lost, and times it from the reference", () => {
    const reference = tracks(gallery("call.json"))[0];
    const analysis = analyse([reference, { ...reference, name: "Saved", words: reference.words.slice(7) }])!;
    expect(analysis.regions).toHaveLength(1);
    expect(analysis.regions[0]).toMatchObject({ kind: "del", start: 0.3, refText: "Hello hello can you hear me speaking" });
  });

  it("has no WER against an empty reference", () => {
    const analysis = analyse(tracks([{ name: "r", text: "" }, { name: "h", text: "a" }]))!;
    expect(analysis.comparisons[0].wer).toBeNull();
  });
});

describe("placeTracks and columns", () => {
  it("places an untimed track under the reference words it aligns to, insertions in the gaps", () => {
    const analysis = analyse(
      tracks([
        { name: "r", words: [{ text: "a", start: 0, end: 1 }, { text: "b", start: 2, end: 3 }] },
        { name: "h", text: "a x b" },
      ]),
    )!;
    const [ref, hyp] = placeTracks(analysis);
    expect(ref![0]).toEqual({ start: 0, end: 1, basis: "word" });
    expect(hyp).toEqual([
      { start: 0, end: 1, basis: "aligned" },
      { start: 1, end: 2, basis: "aligned" },
      { start: 2, end: 3, basis: "aligned" },
    ]);
  });

  it("borrows a timed hypothesis's times for an untimed reference", () => {
    const analysis = analyse(tracks([{ name: "r", text: "a b" }, { name: "h", words: [{ text: "a", start: 1, end: 2 }, { text: "b", start: 3, end: 4 }] }]))!;
    expect(placeTracks(analysis)[0]).toEqual([
      { start: 1, end: 2, basis: "aligned" },
      { start: 3, end: 4, basis: "aligned" },
    ]);
  });

  it("places nothing when no track is timed", () => {
    const analysis = analyse(tracks([{ name: "r", text: "a b" }, { name: "h", text: "a" }]))!;
    expect(placeTracks(analysis)).toEqual([null, null]);
  });

  it("lays the alignment out as columns under reference words with insertion columns", () => {
    const analysis = analyse(tracks([{ name: "r", text: "a b c" }, { name: "h", text: "a x c" }, { name: "h2", text: "y a b" }]))!;
    expect(columns(analysis)).toEqual([
      { ref: null, hyp: [[], [0]] },
      { ref: 0, hyp: [[0], [1]] },
      { ref: 1, hyp: [[1], [2]] },
      { ref: 2, hyp: [[2], []] },
    ]);
  });
});

describe("clock", () => {
  it("formats and parses times", () => {
    expect(formatClock(1189.46)).toBe("19:49.4");
    expect(formatClock(3723, false)).toBe("1:02:03");
    expect(parseClock("19:49")).toBe(1189);
    expect(parseClock("1:02:03")).toBe(3723);
    expect(parseClock("93")).toBe(93);
    expect(parseClock("0:05.5")).toBe(5.5);
    expect(parseClock("1:75")).toBeNull();
    expect(parseClock("soon")).toBeNull();
  });
});

describe("layout", () => {
  it("scales so the densest word in any lane fits the room before the next word, within bounds", () => {
    const words = [{ text: "hello" }, { text: "a" }].map((word) => ({ ...word, start: 0, end: 1, timing: "word" as const, window: null, speaker: null, confidence: null }));
    const measure = (text: string) => text.length * 6;
    const lane = (places: ({ start: number; end: number } | null)[]) => ({ places: places.map((place) => (place === null ? null : { ...place, basis: "word" as const })), words });
    // "hello" has 0.6 s before "a": 63 px/s; "a" (last) has its own 0.1 s: 140 px/s.
    expect(autoScale([lane([{ start: 0, end: 0.5 }, { start: 0.6, end: 0.7 }])], measure, 8)).toBeCloseTo(140, 6);
    // A second lane where "hello" has only 0.2 s before the next word sets the scale.
    expect(autoScale([lane([{ start: 0, end: 0.5 }, { start: 0.6, end: 0.7 }]), lane([{ start: 0, end: 0.3 }, { start: 0.2, end: 1 }])], measure, 8)).toBeCloseTo(190, 6);
    expect(autoScale([lane([{ start: 0, end: 0.5 }, { start: 0.001, end: 1 }])], measure, 8)).toBe(200);
    expect(autoScale([lane([{ start: 0, end: 100 }, null])], measure, 8)).toBe(40);
    expect(autoScale([lane([null, null])], measure, 8)).toBe(120);
  });

  it("spaces ruler labels by zoom", () => {
    expect(tickStep(120)).toBe(1);
    expect(tickStep(300)).toBe(0.5);
    expect(tickStep(2)).toBe(60);
  });

  it("finds the words on screen with a binary search, including a long word starting before the window", () => {
    const places = [
      { start: 0, end: 0.4, basis: "word" as const },
      null,
      { start: 1, end: 6, basis: "word" as const },
      { start: 6.5, end: 7, basis: "word" as const },
      { start: 9, end: 9.5, basis: "word" as const },
    ];
    const index = laneIndex(places);
    expect(index.order).toEqual([0, 2, 3, 4]);
    expect(index.longest).toBe(5);
    const [first, last] = visibleSlice(index, 5, 7);
    expect(index.order.slice(first, last)).toEqual(expect.arrayContaining([2, 3]));
    expect(index.order.slice(first, last)).not.toContain(4);
  });
});
