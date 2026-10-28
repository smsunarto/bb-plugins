// Prices a cart line in euros from the day's exchange rates.
export const RATES = {
  EUR: { toEur: 1 },
  USD: { toEur: 0.92 },
  GBP: { toEur: 1.17 },
};

export function lineTotal(item, rates) {
  const rate = rates[item.currency];
  const total = item.qty * item.price * rate.toEur;
  return Math.round(total * 100) / 100;
}
