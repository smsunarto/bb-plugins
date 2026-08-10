import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "../../server";

interface SourceSettings {
  repository: string;
  branch: string;
  error: string | null;
  defaultRepository: string;
  defaultBranch: string;
}

export function AdvancedPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [saved, setSaved] = useState<SourceSettings | null>(null);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await rpc.call("sourceSettings");
      setSaved(next);
      setRepository(next.repository);
      setBranch(next.branch);
      setError(next.error);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (nextRepository: string, nextBranch: string) => {
    setSaving(true);
    setError(null);
    try {
      const next = await rpc.call("sourceSettingsUpdate", {
        repository: nextRepository,
        branch: nextBranch,
      });
      setSaved(next);
      setRepository(next.repository);
      setBranch(next.branch);
      setError(next.error);
      toast.success("Core source saved");
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    saved !== null && (repository !== saved.repository || branch !== saved.branch);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Core source</CardTitle>
          <CardDescription>
            Choose the public GitHub repository and branch used for update checks and source builds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label htmlFor="agent-proxy-source-repository" className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">Repository</span>
            <Input
              id="agent-proxy-source-repository"
              value={repository}
              disabled={saved === null || saving}
              placeholder="owner/repository"
              spellCheck={false}
              onChange={(event) => setRepository(event.target.value)}
            />
            <span className="block text-xs text-muted-foreground">
              Use owner/name, an HTTPS github.com URL, or a git@github.com source.
            </span>
          </label>

          <label htmlFor="agent-proxy-source-ref" className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">Branch or ref</span>
            <Input
              id="agent-proxy-source-ref"
              value={branch}
              disabled={saved === null || saving}
              placeholder="main"
              spellCheck={false}
              onChange={(event) => setBranch(event.target.value)}
            />
            <span className="block text-xs text-muted-foreground">
              A branch, tag, or full commit SHA. Branch names can contain slashes.
            </span>
          </label>

          {error ? <div className="text-sm text-destructive">{error}</div> : null}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!dirty || saving}
              onClick={() => void save(repository, branch)}
            >
              {saving ? "Saving…" : "Save source"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saved === null || saving}
              onClick={() =>
                void save(saved?.defaultRepository ?? "", saved?.defaultBranch ?? "")
              }
            >
              Reset to defaults
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How source changes apply</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>Saving does not replace or restart the running core.</p>
          <p>
            Use <span className="font-medium text-foreground">Install core</span> on Home to
            resolve the saved ref, build that exact commit, and atomically switch the binary.
          </p>
          <p>The repository must keep the CLIProxyAPI Go entrypoint at cmd/server.</p>
        </CardContent>
      </Card>
    </div>
  );
}
