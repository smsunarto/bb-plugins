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

/**
 * Total tax charged on `taxableMinor`.
 *
 * This is the sum of the rounded per jurisdiction lines, so it can sit a minor
 * unit above or below the rate applied to the total in one step.
 */
export function taxTotalMinor(taxableMinor: number, rates: TaxRate[]): number {
  return taxBreakdown(taxableMinor, rates).reduce((sum, taxLine) => sum + taxLine.amountMinor, 0);
}

/**
 * Blended rate actually charged, as a fraction of the taxable amount.
 *
 * Compounding pushes this above the plain sum of the rates, which is why the
 * receipt cannot just add the basis points up.
 */
export function effectiveRate(taxableMinor: number, rates: TaxRate[]): number {
  if (taxableMinor === 0) return 0;
  return taxTotalMinor(taxableMinor, rates) / taxableMinor;
}

/**
 * Splits the tax on `taxableMinor` across the jurisdictions that claim it.
 *
 * Each jurisdiction is rounded on its own line because that is what the
 * filings ask for: the amount charged is the sum of the rounded lines, not the
 * rounded sum.
 */
export function taxBreakdown(taxableMinor: number, rates: TaxRate[]): TaxLine[] {
  const breakdown: TaxLine[] = [];
  let accumulated = 0;

  for (const entry of rates) {
    const amountMinor = rateAmount(baseFor(taxableMinor, accumulated, entry), entry);
    breakdown.push({ jurisdiction: entry.jurisdiction, amountMinor });
    accumulated += amountMinor;
  }

  return breakdown;
}

/** The amount a single jurisdiction charges against, in minor units. */
function baseFor(taxableMinor: number, accumulated: number, rate: TaxRate): number {
  return rate.compounds ? taxableMinor + accumulated : taxableMinor;
}

/** One jurisdiction's tax, rounded to a whole minor unit. */
function rateAmount(base: number, rate: TaxRate): number {
  return Math.round((base * rate.basisPoints) / BASIS_POINT_DIVISOR);
}

/** One receipt line per jurisdiction, already formatted for display. */
export function describeTax(taxableMinor: number, rates: TaxRate[], currency = "USD"): string[] {
  return taxBreakdown(taxableMinor, rates).map(
    (taxLine) => `${taxLine.jurisdiction}  ${formatMinor(taxLine.amountMinor, currency)}`,
  );
}

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
