import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { rpcContract } from "../../server";

type AuthFile = Record<string, unknown>;

const PROVIDERS = [
  { id: "anthropic" as const, title: "Claude", description: "Anthropic account OAuth (claude.ai subscription)" },
  { id: "codex" as const, title: "Codex", description: "OpenAI/Codex account OAuth (ChatGPT subscription)" },
];

interface FlowState {
  provider: "anthropic" | "codex";
  state: string;
  url: string;
}

function describeQuota(file: AuthFile): string {
  const parts: string[] = [];
  for (const key of ["quota", "quota_exceeded", "available", "unavailable", "status"]) {
    const value = file[key];
    if (value === undefined || value === null || typeof value === "object") continue;
    parts.push(`${key}: ${String(value)}`);
  }
  return parts.join(", ") || "—";
}

export function OAuthPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [files, setFiles] = useState<AuthFile[] | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const flowRef = useRef<FlowState | null>(null);
  flowRef.current = flow;

  const loadFiles = useCallback(async () => {
    try {
      const result = await rpc.call("authFiles");
      setFiles(result.files);
    } catch (cause) {
      setFiles([]);
      toast.error(String(cause instanceof Error ? cause.message : cause));
    }
  }, [rpc]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  // Poll the in-flight OAuth flow every 2s for up to 3 minutes.
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    const startedAt = Date.now();
    const poll = async () => {
      if (cancelled || flowRef.current?.state !== flow.state) return;
      if (Date.now() - startedAt > 180_000) {
        setFlow(null);
        toast.error("authorization timed out");
        return;
      }
      try {
        const result = await rpc.call("oauthPoll", { state: flow.state });
        if (cancelled) return;
        if (result.status === "ok") {
          setFlow(null);
          toast.success("account authorized");
          void loadFiles();
          return;
        }
        if (result.status === "error") {
          setFlow(null);
          toast.error(`authorization failed: ${result.detail ?? "unknown error"}`);
          return;
        }
      } catch {
        // Transient poll failures are fine; keep trying until the deadline.
      }
      setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [flow, rpc, loadFiles]);

  const startFlow = async (provider: "anthropic" | "codex") => {
    try {
      const result = await rpc.call("oauthStart", { provider });
      window.open(result.url, "_blank", "noopener");
      setFlow({ provider, state: result.state, url: result.url });
    } catch (cause) {
      toast.error(String(cause instanceof Error ? cause.message : cause));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {PROVIDERS.map((provider) => (
          <Card key={provider.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{provider.title}</CardTitle>
              <CardDescription>{provider.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {flow?.provider === provider.id ? (
                <>
                  <div className="text-sm text-muted-foreground">
                    Waiting for the browser flow to complete…
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => window.open(flow.url, "_blank", "noopener")}>
                      Re-open page
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setFlow(null)}>
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <Button size="sm" disabled={flow !== null} onClick={() => void startFlow(provider.id)}>
                  Sign in
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Authorized accounts</span>
            <Button size="sm" variant="outline" onClick={() => void loadFiles()}>
              Refresh
            </Button>
          </CardTitle>
          <CardDescription>Credential files in the core's auth directory, with quota state.</CardDescription>
        </CardHeader>
        <CardContent>
          {files === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : files.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No authorized accounts yet — run an OAuth flow above (requires the core to be running).
            </div>
          ) : (
            <div className="divide-y divide-border">
              {files.map((file, index) => {
                const name = typeof file.name === "string" ? file.name : `#${index}`;
                const disabled = file.disabled === true;
                const authIndex =
                  typeof file.auth_index === "string"
                    ? file.auth_index
                    : typeof file.auth_index === "number"
                      ? String(file.auth_index)
                      : null;
                return (
                  <div key={name} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs text-foreground">
                        {name}
                        {disabled ? <span className="ml-2 text-muted-foreground">(disabled)</span> : null}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{describeQuota(file)}</div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void rpc
                          .call("authFileStatus", { name, disabled: !disabled })
                          .then(() => loadFiles())
                          .catch((cause) => toast.error(String(cause)))
                      }
                    >
                      {disabled ? "Enable" : "Disable"}
                    </Button>
                    {authIndex !== null ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void rpc
                            .call("resetQuota", { authIndex })
                            .then(() => {
                              toast.success("quota state reset");
                              return loadFiles();
                            })
                            .catch((cause) => toast.error(String(cause)))
                        }
                      >
                        Reset quota
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant={confirmDelete === name ? "destructive" : "outline"}
                      onClick={() => {
                        if (confirmDelete !== name) {
                          setConfirmDelete(name);
                          return;
                        }
                        setConfirmDelete(null);
                        void rpc
                          .call("authFileDelete", { name })
                          .then(() => {
                            toast.success(`deleted ${name}`);
                            return loadFiles();
                          })
                          .catch((cause) => toast.error(String(cause)));
                      }}
                    >
                      {confirmDelete === name ? "Confirm delete" : "Delete"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
