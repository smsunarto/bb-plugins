// Pure pieces of the Project components (projectKit.tsx and friends): the
// polling schedule and the +/− proportion blocks.

/** First wait before a live component asks BB again. */
export const POLL_START_MS = 4_000;

/** Longest wait between polls. */
export const POLL_MAX_MS = 60_000;

/**
 * The wait before the next poll: doubles from POLL_START_MS with every answer
 * that changed nothing, up to POLL_MAX_MS; a change starts over.
 */
export function pollDelay(unchangedAnswers: number): number {
  return Math.min(POLL_MAX_MS, POLL_START_MS * 2 ** Math.max(0, unchangedAnswers));
}

/** Blocks in the proportion bar beside a file's counts (GitHub's five). */
export const RATIO_BLOCKS = 5;

/**
 * How many blocks are green, red and grey for a file's counts: as many
 * colored blocks as changed lines up to RATIO_BLOCKS, split by share, each
 * side that changed keeping at least one.
 */
export function ratioBlocks(additions: number, deletions: number): { added: number; removed: number; neutral: number } {
  const total = additions + deletions;
  if (!(total > 0)) return { added: 0, removed: 0, neutral: RATIO_BLOCKS };
  const colored = Math.min(RATIO_BLOCKS, total);
  let added = Math.round((colored * additions) / total);
  if (additions > 0 && added === 0) added = 1;
  if (deletions > 0 && added === colored) added = colored - 1;
  return { added, removed: colored - added, neutral: RATIO_BLOCKS - colored };
}

/** The answer's content without when it was read, so two reads compare equal when BB's state didn't change. */
export function answerSignature(answer: unknown): string {
  return JSON.stringify(answer, (key, value: unknown) => (key === "fetchedAt" || key === "takenAt" ? undefined : value));
}
