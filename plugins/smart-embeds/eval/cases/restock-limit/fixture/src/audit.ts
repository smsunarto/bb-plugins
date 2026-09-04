import type { AuditRecord, ChangeAction } from "./types.ts";

const MAX_RECORDS = 500;

const records: AuditRecord[] = [];

export function recordChange(input: {
  sku: string;
  action: ChangeAction;
  delta: number;
  reference?: string;
}): AuditRecord {
  const record: AuditRecord = {
    sku: input.sku,
    action: input.action,
    delta: input.delta,
    reference: input.reference ?? "",
    at: new Date().toISOString(),
  };
  records.push(record);
  // The warehouse only ever reconciles against the recent tail.
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  return record;
}

export function changesFor(sku: string, limit = 20): AuditRecord[] {
  return records.filter((record) => record.sku === sku).slice(-limit);
}

export function recentChanges(limit = 20): AuditRecord[] {
  return records.slice(-limit);
}

export function netMovement(sku: string): number {
  return changesFor(sku, MAX_RECORDS).reduce((sum, record) => sum + record.delta, 0);
}
