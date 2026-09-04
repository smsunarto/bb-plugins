import { groupByAccount, normalizeAccount } from "./accounts.ts";
import type {
  AccountTotal,
  BalanceRow,
  LedgerEntry,
  ParsedLine,
  ParseIssue,
  ParseResult,
} from "./types.ts";

const ENTRY_PATTERN = /^(\S+)\s+(\S+)\s+(\(?-?[\d,.]+\)?)(?:\s+(.*))?$/;
const COMMENT_PREFIXES = [";", "#"];
const COLUMN_GAP = "  ";
const MIN_AMOUNT_WIDTH = 8;

export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function parseDate(raw: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  // Day 0 of the following month is the last day of this one, leap years included.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > lastDay) return null;
  return raw;
}

export function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parenthesized = trimmed.startsWith("(") && trimmed.endsWith(")");
  const body = (parenthesized ? trimmed.slice(1, -1) : trimmed).replace(/,/g, "");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(body)) return null;
  const cents = Math.round(Number(body) * 100);
  return parenthesized ? -cents : cents;
}

export function parseLine(line: string, lineNumber: number): ParsedLine {
  const trimmed = line.trim();
  if (trimmed.length === 0 || isCommentLine(trimmed)) return { kind: "skip" };

  const match = ENTRY_PATTERN.exec(trimmed);
  if (match === null) {
    const message = "expected DATE ACCOUNT AMOUNT [memo]";
    return { kind: "issue", issue: { lineNumber, message } };
  }

  const date = parseDate(match[1] ?? "");
  if (date === null) {
    return { kind: "issue", issue: { lineNumber, message: `unreadable date "${match[1]}"` } };
  }

  const amountCents = parseAmount(match[3] ?? "");
  if (amountCents === null) {
    return { kind: "issue", issue: { lineNumber, message: `unreadable amount "${match[3]}"` } };
  }

  return {
    kind: "entry",
    entry: {
      lineNumber,
      date,
      account: normalizeAccount(match[2] ?? ""),
      memo: (match[4] ?? "").trim(),
      amountCents,
    },
  };
}

export function parseLedger(source: string): ParseResult {
  const entries: LedgerEntry[] = [];
  const issues: ParseIssue[] = [];

  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const parsed = parseLine(line, index + 1);
    if (parsed.kind === "entry") entries.push(parsed.entry);
    if (parsed.kind === "issue") issues.push(parsed.issue);
  }

  entries.sort((left, right) => {
    if (left.date !== right.date) return left.date < right.date ? -1 : 1;
    return left.lineNumber - right.lineNumber;
  });
  return { entries, issues };
}

export function groupThousands(whole: number): string {
  const digits = String(whole);
  let grouped = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ",";
    grouped += digits[index];
  }
  return grouped;
}

/**
 * Amounts land in a fixed-width column, so the sign has to read at a glance
 * without pushing the digits out of alignment.
 */
export function formatAmount(cents: number): string {
  const magnitude = Math.abs(Math.trunc(cents));
  const whole = Math.floor(magnitude / 100);
  const fraction = magnitude % 100;
  const body = `${groupThousands(whole)}.${String(fraction).padStart(2, "0")}`;
  return cents < 0 ? `(${body})` : body;
}

export function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

export function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function runningBalances(entries: LedgerEntry[]): BalanceRow[] {
  let balanceCents = 0;
  const rows: BalanceRow[] = [];
  for (const entry of entries) {
    balanceCents += entry.amountCents;
    rows.push({ entry, balanceCents });
  }
  return rows;
}

export function balanceAt(entries: LedgerEntry[], date: string): number {
  let balanceCents = 0;
  for (const entry of entries) {
    if (entry.date > date) break;
    balanceCents += entry.amountCents;
  }
  return balanceCents;
}

export type ColumnWidths = {
  date: number;
  account: number;
  amount: number;
  balance: number;
};

export function columnWidths(rows: BalanceRow[]): ColumnWidths {
  const widths: ColumnWidths = {
    date: "DATE".length,
    account: "ACCOUNT".length,
    amount: MIN_AMOUNT_WIDTH,
    balance: MIN_AMOUNT_WIDTH,
  };
  for (const row of rows) {
    widths.date = Math.max(widths.date, row.entry.date.length);
    widths.account = Math.max(widths.account, row.entry.account.length);
    widths.amount = Math.max(widths.amount, formatAmount(row.entry.amountCents).length);
    widths.balance = Math.max(widths.balance, formatAmount(row.balanceCents).length);
  }
  return widths;
}

export function renderTable(rows: BalanceRow[]): string {
  if (rows.length === 0) return "no entries";

  const widths = columnWidths(rows);
  const lines = [
    [
      padRight("DATE", widths.date),
      padRight("ACCOUNT", widths.account),
      padLeft("AMOUNT", widths.amount),
      padLeft("BALANCE", widths.balance),
    ].join(COLUMN_GAP),
  ];

  for (const row of rows) {
    lines.push(
      [
        padRight(row.entry.date, widths.date),
        padRight(row.entry.account, widths.account),
        padLeft(formatAmount(row.entry.amountCents), widths.amount),
        padLeft(formatAmount(row.balanceCents), widths.balance),
      ].join(COLUMN_GAP),
    );
  }
  return lines.join("\n");
}

export function accountTotals(entries: LedgerEntry[]): AccountTotal[] {
  return groupByAccount(entries);
}

export function renderTotals(totals: AccountTotal[]): string {
  const accountWidth = totals.reduce((width, total) => Math.max(width, total.account.length), 0);
  const amountWidth = totals.reduce(
    (width, total) => Math.max(width, formatAmount(total.totalCents).length),
    MIN_AMOUNT_WIDTH,
  );
  return totals
    .map((total) => {
      const account = padRight(total.account, accountWidth);
      const amount = padLeft(formatAmount(total.totalCents), amountWidth);
      const count = total.entryCount === 1 ? "1 entry" : `${total.entryCount} entries`;
      return `${account}${COLUMN_GAP}${amount}${COLUMN_GAP}${count}`;
    })
    .join("\n");
}

export function renderIssues(issues: ParseIssue[]): string {
  return issues.map((issue) => `line ${issue.lineNumber}: ${issue.message}`).join("\n");
}
