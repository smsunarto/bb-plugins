export type LedgerEntry = {
  lineNumber: number;
  date: string;
  account: string;
  memo: string;
  amountCents: number;
};

export type ParseIssue = {
  lineNumber: number;
  message: string;
};

export type ParsedLine =
  | { kind: "entry"; entry: LedgerEntry }
  | { kind: "issue"; issue: ParseIssue }
  | { kind: "skip" };

export type ParseResult = {
  entries: LedgerEntry[];
  issues: ParseIssue[];
};

export type BalanceRow = {
  entry: LedgerEntry;
  balanceCents: number;
};

export type AccountTotal = {
  account: string;
  entryCount: number;
  totalCents: number;
};
