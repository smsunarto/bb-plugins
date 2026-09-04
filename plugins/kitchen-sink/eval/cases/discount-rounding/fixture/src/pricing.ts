import { formatMinor } from "./money.ts";

export interface LineItem {
  sku: string;
  quantity: number;
  unitPriceMinor: number;
  /** Discount carried by the item itself, such as a clearance markdown. */
  discountPercent?: number;
}

export interface PricedLine {
  sku: string;
  quantity: number;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
}

export interface Coupon {
  code: string;
  percentOff: number;
  appliesTo?: (item: LineItem) => boolean;
}

/**
 * Applies a percentage discount to an amount in minor units.
 *
 * The result is truncated, because a charge may never carry a fractional
 * minor unit.
 */
export function applyDiscount(amountMinor: number, percentOff: number): number {
  if (percentOff <= 0) return amountMinor;
  if (percentOff >= 100) return 0;
  return Math.floor(amountMinor * (1 - percentOff / 100));
}

/** A coupon replaces the item's own discount rather than stacking with it. */
function discountPercentFor(item: LineItem, coupon?: Coupon): number {
  if (coupon && (coupon.appliesTo?.(item) ?? true)) return coupon.percentOff;
  return item.discountPercent ?? 0;
}

export function priceLine(item: LineItem, coupon?: Coupon): PricedLine {
  const grossMinor = item.unitPriceMinor * item.quantity;
  const netMinor = applyDiscount(grossMinor, discountPercentFor(item, coupon));
  return {
    sku: item.sku,
    quantity: item.quantity,
    grossMinor,
    discountMinor: grossMinor - netMinor,
    netMinor,
  };
}

export function priceCart(items: LineItem[], coupon?: Coupon): PricedLine[] {
  return items.map((item) => priceLine(item, coupon));
}

export function subtotalMinor(lines: PricedLine[]): number {
  return lines.reduce((total, line) => total + line.netMinor, 0);
}

export function describeLine(line: PricedLine, currency = "USD"): string {
  const net = formatMinor(line.netMinor, currency);
  const head = `${line.sku} x${line.quantity}  ${net}`;
  if (line.discountMinor === 0) return head;
  return `${head} (saved ${formatMinor(line.discountMinor, currency)})`;
}
