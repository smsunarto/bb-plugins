function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Time of day for a comment from today, otherwise its date, both local. */
export function formatWhen(ms: number, nowMs: number): string {
  const at = new Date(ms);
  const now = new Date(nowMs);
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay
    ? `${pad(at.getHours())}:${pad(at.getMinutes())}`
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
