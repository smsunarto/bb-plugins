/** The panel's one way of saying "nothing to draw here, and why". */
export function Notice({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="my-4 rounded-md border border-border bg-card px-3 py-2.5 text-muted-foreground">
      <p className="font-semibold text-foreground">{title}</p>
      {detail ? <p className="mt-1 [overflow-wrap:anywhere]">{detail}</p> : null}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return <p className="my-2.5 text-muted-foreground">{label}</p>;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
