import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyField } from "@/components/copy-field";
import type { rpcContract } from "../../server";

interface AgentsState {
  claude: { applied: boolean; canRestore: boolean; settingsPath: string; lastBackup: string | null };
  codex: { codexHomePath: string; generated: boolean; envKey: string };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function AgentsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<AgentsState | null>(null);
  const [endpoints, setEndpoints] = useState<{ openai: string; anthropic: string; apiKey: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await rpc.call("agentsStatus"));
      const result = await rpc.call("endpoints");
      setEndpoints({ openai: result.openai, anthropic: result.anthropic, apiKey: result.apiKey });
    } catch (cause) {
      toast.error(String(cause instanceof Error ? cause.message : cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      toast.success(await fn());
      await load();
    } catch (cause) {
      toast.error(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Claude Code</span>
            {state ? (
              <span className="text-sm text-muted-foreground">
                {state.claude.applied
                  ? "routed through proxy"
                  : state.claude.canRestore
                    ? "managed values changed"
                    : "not applied"}
              </span>
            ) : null}
          </CardTitle>
          <CardDescription>
            Merges ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN into the env block of{" "}
            <span className="font-mono">{state?.claude.settingsPath ?? "~/.claude/settings.json"}</span>.
            ~/.claude.json is never touched. Apply records the previous values; Restore reinstates them while
            preserving any values changed afterward.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || state?.claude.applied === true}
              onClick={() =>
                void act(async () => {
                  const result = await rpc.call("agentsApply", { agent: "claude" });
                  return result.backupPath
                    ? `applied (backup: ${result.backupPath})`
                    : "applied (file created)";
                })
              }
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || state?.claude.canRestore !== true}
              onClick={() =>
                void act(async () => {
                  const result = await rpc.call("agentsRestore", { agent: "claude" });
                  return result.detail;
                })
              }
            >
              Restore
            </Button>
          </div>
          {state?.claude.lastBackup ? (
            <div className="truncate text-xs text-muted-foreground">
              Last backup: <span className="font-mono">{state.claude.lastBackup}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Codex</CardTitle>
          <CardDescription>
            Two zero-collision options — ~/.codex/config.toml is never touched, so a generated one stays
            intact. Either
            export env vars per invocation, or generate a standalone CODEX_HOME (note: it does not inherit
            your normal Codex config such as MCP servers).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {endpoints ? (
            <>
              <CopyField
                label="Per-invocation Codex command"
                value={`OPENAI_API_KEY='${endpoints.apiKey}' codex -c 'openai_base_url="${endpoints.openai}"'`}
              />
              {state?.codex.generated ? (
                <CopyField
                  label="Command using the generated CODEX_HOME"
                  value={`env CODEX_HOME=${shellQuote(state.codex.codexHomePath)} ${state.codex.envKey}=${shellQuote(endpoints.apiKey)} codex`}
                />
              ) : null}
            </>
          ) : (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || state?.codex.generated === true}
              onClick={() =>
                void act(async () => {
                  await rpc.call("agentsApply", { agent: "codex" });
                  return "generated standalone CODEX_HOME";
                })
              }
            >
              Generate CODEX_HOME
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || state?.codex.generated === false}
              onClick={() =>
                void act(async () => {
                  const result = await rpc.call("agentsRestore", { agent: "codex" });
                  return result.detail;
                })
              }
            >
              Remove generated config
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Anything OpenAI-compatible</CardTitle>
          <CardDescription>Point any other client at the proxy with these values.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {endpoints ? (
            <>
              <CopyField label="Base URL" value={endpoints.openai} />
              <CopyField label="API key" value={endpoints.apiKey} masked />
            </>
          ) : (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
