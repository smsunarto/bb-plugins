const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function padLabel(label: string, width: number): string {
  if (label.length >= width) return label;
  return label + " ".repeat(width - label.length);
}

export function formatWind(speedKph: number, degrees: number): string {
  const rounded = Math.round(speedKph);
  if (rounded === 0) return "calm";
  return `${rounded} km/h ${compassPoint(degrees)}`;
}

export function compassPoint(degrees: number): string {
  // Degrees arrive unbounded from the station feed, and the sector boundaries
  // sit halfway between the points, hence the half-step before the divide.
  const normalized = ((degrees % 360) + 360) % 360;
  const sector = Math.floor(normalized / 45 + 0.5) % COMPASS.length;
  return COMPASS[sector] ?? "N";
}

export function formatHumidity(fraction: number): string {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return `${Math.round(clamped * 100)}%`;
}

export function formatClock(timestamp: number, offsetMinutes = 0): string {
  const shifted = new Date(timestamp + offsetMinutes * 60_000);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
