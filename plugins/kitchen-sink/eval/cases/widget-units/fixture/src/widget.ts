import { formatClock, formatHumidity, formatWind, padLabel } from "./format.ts";
import { conditionLabel, iconFor } from "./icons.ts";

export interface Reading {
  place: string;
  condition: string;
  temperatureC: number;
  feelsLikeC: number;
  humidity: number;
  windKph: number;
  windDegrees: number;
  observedAt: number;
  utcOffsetMinutes?: number;
}

const LABEL_WIDTH = 10;

export function formatTemperature(celsius: number): string {
  const rounded = Math.round(celsius * 10) / 10;
  // A rounded value of exactly zero can arrive as -0, which prints as "-0.0".
  const safe = rounded === 0 ? 0 : rounded;
  return `${safe.toFixed(1)} C`;
}

export function renderWidget(reading: Reading): string {
  const offset = reading.utcOffsetMinutes ?? 0;
  const rows: [string, string][] = [
    ["Now", `${iconFor(reading.condition)} ${formatTemperature(reading.temperatureC)}`],
    ["Feels", formatTemperature(reading.feelsLikeC)],
    ["Sky", conditionLabel(reading.condition)],
    ["Wind", formatWind(reading.windKph, reading.windDegrees)],
    ["Humidity", formatHumidity(reading.humidity)],
    ["Observed", formatClock(reading.observedAt, offset)],
  ];

  const lines = rows.map(([label, value]) => `${padLabel(label, LABEL_WIDTH)}${value}`);
  return [reading.place, "-".repeat(reading.place.length), ...lines].join("\n");
}

export function renderCompact(reading: Reading): string {
  const parts = [
    iconFor(reading.condition),
    formatTemperature(reading.temperatureC),
    formatWind(reading.windKph, reading.windDegrees),
  ];
  return `${reading.place}: ${parts.join(" ")}`;
}

export function summarize(readings: Reading[]): string {
  if (readings.length === 0) return "no readings";
  return readings.map((reading) => renderCompact(reading)).join("\n");
}
