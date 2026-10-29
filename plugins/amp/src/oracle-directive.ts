export const ORACLE_DIRECTIVE_ID = "amp-oracle";

export type OracleReportStatus = "running" | "completed" | "error";

export interface OracleReport {
  id: string;
  request: string | null;
  response: string;
  status: OracleReportStatus;
  createdAt: string;
}

export function isOracleReportId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function oracleDirective(reportId: string): string | null {
  return isOracleReportId(reportId) ? `::${ORACLE_DIRECTIVE_ID}{reportId="${reportId}"}` : null;
}
