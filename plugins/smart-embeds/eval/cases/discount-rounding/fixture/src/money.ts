export const MINOR_UNITS_PER_MAJOR = 100;

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CAD: "$" };

/** Converts a major unit amount, such as 19.99, into minor units. */
export function toMinor(major: number): number {
  return Math.round(major * MINOR_UNITS_PER_MAJOR);
}

export function toMajor(minor: number): number {
  return minor / MINOR_UNITS_PER_MAJOR;
}

/** Renders minor units as "$1,234.50". An unknown currency gets no symbol. */
export function formatMinor(minor: number, currency = "USD"): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  const major = Math.trunc(absolute / MINOR_UNITS_PER_MAJOR);
  const remainder = absolute % MINOR_UNITS_PER_MAJOR;
  const cents = String(remainder).padStart(2, "0");
  return `${sign}${SYMBOLS[currency] ?? ""}${withThousands(major)}.${cents}`;
}

function withThousands(value: number): string {
  const digits = String(value);
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}
