import { readFileSync } from "node:fs";
import { rollUp } from "./accounts.ts";
import {
  accountTotals,
  formatAmount,
  parseLedger,
  renderIssues,
  renderTable,
  renderTotals,
  runningBalances,
} from "./ledger.ts";
import type { LedgerEntry } from "./types.ts";

export function monthOf(entry: LedgerEntry): string {
  return entry.date.slice(0, 7);
}

export function entriesInMonth(entries: LedgerEntry[], month: string): LedgerEntry[] {
  return entries.filter((entry) => monthOf(entry) === month);
}

export function knownMonths(entries: LedgerEntry[]): string[] {
  return [...new Set(entries.map(monthOf))].sort();
}

export function renderMonthlyReport(source: string, month: string): string {
  const { entries, issues } = parseLedger(source);
  const selected = entriesInMonth(entries, month);
  const totals = accountTotals(selected);
  const sections = [
    `Ledger for ${month}`,
    renderTable(runningBalances(selected)),
    "",
    renderTotals(totals),
    `Expenses: ${formatAmount(rollUp(totals, "Expenses"))}`,
  ];
  if (issues.length > 0)
    sections.push("", `${issues.length} skipped line(s)`, renderIssues(issues));
  return sections.join("\n");
}

if (import.meta.main) {
  const [path, month] = process.argv.slice(2);
  if (path === undefined) {
    console.error("usage: bun src/report.ts <journal> [YYYY-MM]");
    process.exit(1);
  }
  const source = readFileSync(path, "utf8");
  const selectedMonth = month ?? knownMonths(parseLedger(source).entries).at(-1) ?? "";
  console.log(renderMonthlyReport(source, selectedMonth));
}
