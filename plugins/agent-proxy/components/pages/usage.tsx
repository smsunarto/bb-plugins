import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { rpcContract } from "../../server";

// GET /api-key-usage groups records by provider, then by "base_url|api_key".
// Current rows contain aggregate success/failed counts plus 20 recent request
// buckets; historical numeric series are also supported.

function bucketValue(entry: unknown): number | null {
  if (typeof entry === "number") return entry;
  if (typeof entry === "object" && entry !== null) {
    const record = entry as Record<string, unknown>;
    if (typeof record.success === "number" && typeof record.failed === "number") {
      return record.success + record.failed;
    }
    for (const key of ["total", "count", "requests", "tokens"]) {
      if (typeof record[key] === "number") return record[key];
    }
  }
  return null;
}

function usageRow(value: unknown): { success: number; failed: number; buckets: unknown[] } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.success !== "number" ||
    typeof row.failed !== "number" ||
    !Array.isArray(row.recent_requests)
  ) {
    return null;
  }
  return { success: row.success, failed: row.failed, buckets: row.recent_requests };
}

function BucketStrip({ buckets }: { buckets: unknown[] }) {
  const values = buckets.map(bucketValue);
  if (values.some((value) => value === null)) {
    return (
      <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs text-foreground">
        {JSON.stringify(buckets, null, 2)}
      </pre>
    );
  }
  const numbers = values as number[];
  const max = Math.max(...numbers, 1);
  const total = numbers.reduce((sum, value) => sum + value, 0);
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-8 flex-1 items-end gap-px">
        {/*
          Index is the identity here: each bar is a fixed bucket on the time
          axis, so position is what distinguishes it. Values repeat freely.
        */}
        {/* oxlint-disable react/no-array-index-key */}
        {numbers.map((value, index) => (
          <div
            key={index}
            title={`${value}`}
            className="min-w-1 flex-1 rounded-sm bg-primary/70"
            style={{ height: `${Math.max(4, (value / max) * 100)}%`, opacity: value === 0 ? 0.2 : 1 }}
          />
        ))}
        {/* oxlint-enable react/no-array-index-key */}
      </div>
      <div className="w-20 text-right font-mono text-xs text-muted-foreground">{total} total</div>
    </div>
  );
}

function maskKey(key: string): string {
  const parts = key.split("|");
  const secret = parts.at(-1) ?? key;
  const masked = secret.length > 10 ? `${secret.slice(0, 6)}…${secret.slice(-4)}` : secret;
  return parts.length > 1 ? [...parts.slice(0, -1), masked].join(" | ") : masked;
}

export function UsagePage() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<unknown>(undefined);
  const [showRaw, setShowRaw] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("usage");
      setData(result.data);
    } catch (cause) {
      setData(null);
      toast.error(String(cause instanceof Error ? cause.message : cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const providers =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? Object.entries(data as Record<string, unknown>)
      : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Recent activity</span>
            <span className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowRaw((current) => !current)}>
                {showRaw ? "Charts" : "Raw JSON"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Refresh
              </Button>
            </span>
          </CardTitle>
          <CardDescription>
            The core reports the last ~3.3 hours as 20 fixed 10-minute buckets per provider key. (Durable
            per-request history was removed from CLIProxyAPI in v6.10.0.)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data === undefined ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : data === null ? (
            <div className="text-sm text-muted-foreground">Unavailable — is the core running?</div>
          ) : showRaw || providers === null ? (
            <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
              {JSON.stringify(data, null, 2)}
            </pre>
          ) : providers.length === 0 ? (
            <div className="text-sm text-muted-foreground">No usage recorded yet.</div>
          ) : (
            <div className="space-y-4">
              {providers.map(([provider, byKey]) => (
                <div key={provider}>
                  <div className="pb-1 text-sm font-medium text-foreground">{provider}</div>
                  {typeof byKey === "object" && byKey !== null && !Array.isArray(byKey) ? (
                    <div className="space-y-2">
                      {Object.entries(byKey as Record<string, unknown>).map(([key, value]) => {
                        const row = usageRow(value);
                        return (
                          <div key={key} className="rounded-md border border-border p-2">
                            <div className="flex items-center justify-between gap-3 pb-1">
                              <div className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                                {maskKey(key)}
                              </div>
                              {row ? (
                                <div className="shrink-0 text-xs text-muted-foreground">
                                  {row.success} succeeded · {row.failed} failed
                                </div>
                              ) : null}
                            </div>
                            {row ? (
                              <BucketStrip buckets={row.buckets} />
                            ) : Array.isArray(value) ? (
                              <BucketStrip buckets={value} />
                            ) : (
                              <pre className="overflow-auto font-mono text-xs text-foreground">
                                {JSON.stringify(value)}
                              </pre>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <pre className="overflow-auto font-mono text-xs text-foreground">{JSON.stringify(byKey)}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
