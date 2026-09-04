import type { AccountTotal, LedgerEntry } from "./types.ts";

const SEPARATOR = ":";

/** Journals are hand-written, so `expenses:  food ` and `Expenses:Food` are the same account. */
export function normalizeAccount(raw: string): string {
  const segments = raw
    .split(SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1).toLowerCase());
  return segments.length === 0 ? "Unknown" : segments.join(SEPARATOR);
}

export function accountSegments(account: string): string[] {
  return account.split(SEPARATOR);
}

export function accountDepth(account: string): number {
  return accountSegments(account).length;
}

export function parentAccount(account: string): string | null {
  const segments = accountSegments(account);
  if (segments.length < 2) return null;
  return segments.slice(0, -1).join(SEPARATOR);
}

export function isSubaccountOf(account: string, parent: string): boolean {
  return account === parent || account.startsWith(`${parent}${SEPARATOR}`);
}

export function groupByAccount(entries: LedgerEntry[]): AccountTotal[] {
  const totals = new Map<string, AccountTotal>();
  for (const entry of entries) {
    const existing = totals.get(entry.account);
    if (existing === undefined) {
      totals.set(entry.account, {
        account: entry.account,
        entryCount: 1,
        totalCents: entry.amountCents,
      });
      continue;
    }
    existing.entryCount += 1;
    existing.totalCents += entry.amountCents;
  }
  return [...totals.values()].sort((left, right) => left.account.localeCompare(right.account));
}

export function rollUp(totals: AccountTotal[], parent: string): number {
  let sum = 0;
  for (const total of totals) {
    if (isSubaccountOf(total.account, parent)) sum += total.totalCents;
  }
  return sum;
}
