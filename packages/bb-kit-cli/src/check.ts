export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  file?: string;
  hint: string;
}

export function formatDiagnostic(value: Diagnostic): string {
  const location = value.file ? `${value.file}: ` : "";
  return `${value.code} ${location}${value.message}\n  ${value.hint}`;
}
