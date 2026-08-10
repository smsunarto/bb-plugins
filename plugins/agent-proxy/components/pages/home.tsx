import { useEffect, useState } from "react";
import { useRealtime } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyField } from "@/components/copy-field";
import { StatusBadge } from "@/components/status-badge";
import { useCoreStatus } from "@/components/use-core-status";
import { canStopService } from "@/lib/service-actions";

export function HomePage() {
  const { status, error, refresh, rpc } = useCoreStatus();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [installStage, setInstallStage] = useState<string | null>(null);
  const [connectivity, setConnectivity] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);

  useEffect(() => {
    void rpc.call("endpoints").then(
      (endpoints) => setApiKey(endpoints.apiKey),
      () => setApiKey(null),
    );
  }, [rpc]);

  useRealtime("install", (payload) => {
    const stage = (payload as { stage?: string }).stage;
    setInstallStage(stage === "done" ? null : (stage ?? null));
    if (stage === "done") void refresh();
  });

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await refresh();
    } catch (cause) {
      toast.error(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(null);
    }
  };

  const installLabel = status?.installedVersion
    ? status.latest && status.latest.version !== status.installedVersion
      ? `Update to ${status.latest.version}`
      : "Reinstall"
    : "Install core";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span>CLIProxyAPI core</span>
            {status ? <StatusBadge state={status.state} /> : <span className="text-sm text-muted-foreground">…</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? <div className="text-sm text-destructive">{error}</div> : null}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">Installed</div>
              <div className="text-foreground">{status?.installedVersion ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Latest</div>
              <div className="text-foreground">{status?.latest?.version ?? "unknown"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Port</div>
              <div className="text-foreground">{status?.port ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">PID</div>
              <div className="text-foreground">{status?.pid ?? "—"}</div>
            </div>
          </div>
          <div className="text-sm">
            <div className="text-xs text-muted-foreground">Source</div>
            <div className="break-all font-mono text-xs text-foreground">
              {status ? `${status.source.repository}#${status.source.branch}` : "—"}
            </div>
          </div>
          <div className="text-sm">
            <div className="text-xs text-muted-foreground">Service</div>
            <div className="text-foreground">
              {status
                ? `${status.service.manager} · ${status.service.loaded ? "loaded" : "not loaded"}`
                : "—"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              The proxy stays available when bb is closed. Stop disables the login service until it is started again.
            </div>
          </div>
          {status?.source.error ? (
            <div className="text-sm text-destructive">Source setting error: {status.source.error}</div>
          ) : null}
          {status?.state === "crashed" && status.lastExit ? (
            <div className="text-sm text-destructive">
              Core keeps exiting (code {status.lastExit.code ?? "?"}, launch #{status.crashCount + 1}). Check the
              log tail below — a port conflict is the usual cause.
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy !== null || !status || status.state === "not-installed" || status.state === "running"}
              onClick={() => void act("start", () => rpc.call("start"))}
            >
              Start
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy !== null ||
                !status ||
                !canStopService(status.state, status.service.loaded)
              }
              onClick={() => void act("stop", () => rpc.call("stop"))}
            >
              Stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !status || status.state === "not-installed"}
              onClick={() => void act("restart", () => rpc.call("restart"))}
            >
              Restart
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void act("check", async () => {
                  const result = await rpc.call("checkLatest");
                  toast.success(
                    result.updateAvailable
                      ? `${result.latest} is available (installed: ${result.installed ?? "none"})`
                      : `up to date (${result.latest})`,
                  );
                })
              }
            >
              Check for updates
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || installStage !== null}
              onClick={() =>
                void act("install", async () => {
                  const result = await rpc.call("install", {});
                  toast.success(`installed CLIProxyAPI ${result.installedVersion}`);
                })
              }
            >
              {installStage ? `${installStage}…` : installLabel}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void act("connectivity", async () => {
                  const result = await rpc.call("connectivity");
                  setConnectivity(result.detail);
                  if (result.ok) toast.success(result.detail);
                  else toast.error(result.detail);
                })
              }
            >
              Check connectivity
            </Button>
          </div>
          {connectivity ? <div className="text-xs text-muted-foreground">{connectivity}</div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Local endpoints</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {status ? (
            <>
              <CopyField label="OpenAI-compatible base URL" value={status.endpoints.openai} />
              <CopyField label="Anthropic base URL (ANTHROPIC_BASE_URL)" value={status.endpoints.anthropic} />
              <CopyField label="Gemini base URL" value={status.endpoints.gemini} />
              {apiKey ? <CopyField label="Local API key" value={apiKey} masked /> : null}
            </>
          ) : (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Core log tail</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void rpc.call("coreLogs").then(
                  (result) => setLogs(result.lines),
                  (cause) => toast.error(String(cause)),
                )
              }
            >
              {logs === null ? "Load" : "Refresh"}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {logs === null ? (
            <div className="text-sm text-muted-foreground">Not loaded.</div>
          ) : logs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No output captured yet.</div>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
              {logs.join("\n")}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
