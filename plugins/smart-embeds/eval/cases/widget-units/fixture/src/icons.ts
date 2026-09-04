export type ConditionCode =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "rain"
  | "snow"
  | "storm"
  | "fog";

const GLYPHS: Record<ConditionCode, string> = {
  clear: "*",
  "partly-cloudy": "-*-",
  cloudy: "===",
  rain: "///",
  snow: "***",
  storm: "/!/",
  fog: "~~~",
};

const LABELS: Record<ConditionCode, string> = {
  clear: "Clear",
  "partly-cloudy": "Partly cloudy",
  cloudy: "Cloudy",
  rain: "Rain",
  snow: "Snow",
  storm: "Thunderstorms",
  fog: "Fog",
};

export function isConditionCode(code: string): code is ConditionCode {
  return code in GLYPHS;
}

export function iconFor(code: string): string {
  return isConditionCode(code) ? GLYPHS[code] : "?";
}

export function conditionLabel(code: string): string {
  // Feeds occasionally send a code we have no art for. Showing the raw code
  // beats showing nothing, and it makes the missing art obvious in a report.
  return isConditionCode(code) ? LABELS[code] : code;
}
