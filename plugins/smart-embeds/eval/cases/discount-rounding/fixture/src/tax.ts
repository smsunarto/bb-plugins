import { formatMinor } from "./money.ts";

export interface TaxRate {
  jurisdiction: string;
  /** Rate in basis points, so 8.875% is 887.5. */
  basisPoints: number;
  /** Charged on the net plus the tax already worked out above this line. */
  compounds: boolean;
}

export interface TaxLine {
  jurisdiction: string;
  amountMinor: number;
}

const BASIS_POINT_DIVISOR = 10_000;

export const RATES: Record<string, TaxRate[]> = {
  "US-CA": [
    { jurisdiction: "California", basisPoints: 725, compounds: false },
    { jurisdiction: "Los Angeles County", basisPoints: 225, compounds: false },
  ],
  "US-NY": [
    { jurisdiction: "New York", basisPoints: 400, compounds: false },
    { jurisdiction: "New York City", basisPoints: 450, compounds: false },
    { jurisdiction: "MCTD", basisPoints: 37.5, compounds: false },
  ],
  "CA-QC": [
    { jurisdiction: "GST", basisPoints: 500, compounds: false },
    { jurisdiction: "QST", basisPoints: 997.5, compounds: true },
  ],
};

export function ratesFor(region: string): TaxRate[] {
  return RATES[region] ?? [];
}

/**
 * Splits the tax on `netMinor` across the jurisdictions that claim it.
 *
 * Each jurisdiction is rounded on its own line because that is what the
 * filings ask for: the amount charged is the sum of the rounded lines, not the
 * rounded sum.
 */
export function taxBreakdown(netMinor: number, rates: TaxRate[]): TaxLine[] {
  const lines: TaxLine[] = [];
  let charged = 0;

  for (const rate of rates) {
    const base = rate.compounds ? netMinor + charged : netMinor;
    const amountMinor = Math.round((base * rate.basisPoints) / BASIS_POINT_DIVISOR);
    lines.push({ jurisdiction: rate.jurisdiction, amountMinor });
    charged += amountMinor;
  }

  return lines;
}

export function taxTotalMinor(netMinor: number, rates: TaxRate[]): number {
  return taxBreakdown(netMinor, rates).reduce((total, line) => total + line.amountMinor, 0);
}

/** Blended rate actually charged, which compounding pushes above the sum of the rates. */
export function effectiveRate(netMinor: number, rates: TaxRate[]): number {
  if (netMinor === 0) return 0;
  return taxTotalMinor(netMinor, rates) / netMinor;
}

export function describeTax(netMinor: number, rates: TaxRate[], currency = "USD"): string[] {
  return taxBreakdown(netMinor, rates).map(
    (line) => `${line.jurisdiction}  ${formatMinor(line.amountMinor, currency)}`,
  );
}
