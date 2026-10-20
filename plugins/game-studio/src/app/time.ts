const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

/** A past moment as "just now", "5 min. ago", "3 days ago", or a date once it is weeks old. */
export function ago(time: number, now = Date.now()) {
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 14) return relative.format(-days, "day");
  return new Date(time).toLocaleDateString();
}
