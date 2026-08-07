import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyField({
  label,
  value,
  masked = false,
}: {
  label: string;
  value: string;
  masked?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard can be unavailable in some webviews; the value stays visible.
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-xs text-foreground">
          {masked ? `${value.slice(0, 6)}…${value.slice(-4)}` : value}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
