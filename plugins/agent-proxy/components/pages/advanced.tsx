import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "../../server";

type RoutingStrategy = "round-robin" | "fill-first" | "weighted-round-robin";

interface SettingsValues {
  autostart: boolean;
  cloudflareQuickTunnelForCursor: boolean;
  port: number;
  sourceRepository: string;
  sourceBranch: string;
  routingStrategy: RoutingStrategy;
}

interface SettingsView {
  values: SettingsValues;
  defaults: SettingsValues;
  managementKeyConfigured: boolean;
  sourceError: string | null;
}

const EMPTY_SETTINGS: SettingsValues = {
  autostart: true,
  cloudflareQuickTunnelForCursor: false,
  port: 8317,
  sourceRepository: "router-for-me/CLIProxyAPI",
  sourceBranch: "latest",
  routingStrategy: "round-robin",
};

function ToggleSetting({
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      aria-label={label}
      className="flex items-start gap-3 rounded-md border border-border p-3 text-sm"
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="space-y-1">
        <span className="block font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

export function AdvancedPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [saved, setSaved] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsValues>(EMPTY_SETTINGS);
  const [managementKey, setManagementKey] = useState("");
  const [clearManagementKey, setClearManagementKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await rpc.call("configuration");
      setSaved(next);
      setDraft(next.values);
      setError(next.sourceError);
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = <Key extends keyof SettingsValues>(key: Key, value: SettingsValues[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const key = managementKey.trim();
      const next = await rpc.call("configurationUpdate", {
        ...draft,
        managementKey: clearManagementKey
          ? { action: "clear" }
          : key
            ? { action: "set", value: key }
            : { action: "keep" },
      });
      setSaved(next);
      setDraft(next.values);
      setManagementKey("");
      setClearManagementKey(false);
      setError(next.sourceError);
      toast.success("Agent Proxy settings saved");
    } catch (cause) {
      const message = String(cause instanceof Error ? cause.message : cause);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (saved === null) return;
    setDraft(saved.defaults);
    setManagementKey("");
    setClearManagementKey(saved.managementKeyConfigured);
    setError(null);
  };

  const dirty =
    saved !== null &&
    (JSON.stringify(draft) !== JSON.stringify(saved.values) ||
      managementKey.trim().length > 0 ||
      clearManagementKey);
  const disabled = saved === null || saving;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Service</CardTitle>
          <CardDescription>
            Control the local CLIProxyAPI process and credential routing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleSetting
            checked={draft.autostart}
            disabled={disabled}
            label="Keep the proxy running as a login service"
            description="The operating system starts it at login and keeps it running when bb is closed."
            onChange={(checked) => update("autostart", checked)}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <label htmlFor="agent-proxy-port" className="block space-y-1.5 text-sm">
              <span className="font-medium text-foreground">Proxy listen port</span>
              <Input
                id="agent-proxy-port"
                type="number"
                min={1}
                max={65_535}
                value={draft.port}
                disabled={disabled}
                onChange={(event) => update("port", Number(event.target.value))}
              />
            </label>

            <label htmlFor="agent-proxy-routing" className="block space-y-1.5 text-sm">
              <span className="font-medium text-foreground">Credential routing</span>
              <select
                id="agent-proxy-routing"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                value={draft.routingStrategy}
                disabled={disabled}
                onChange={(event) =>
                  update("routingStrategy", event.target.value as RoutingStrategy)
                }
              >
                <option value="round-robin">Round robin</option>
                <option value="fill-first">Fill first</option>
                <option value="weighted-round-robin">Weighted round robin</option>
              </select>
              <span className="block text-xs text-muted-foreground">
                Fill first preserves upstream prompt caches. Round robin rotates each request.
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cursor BYOK</CardTitle>
          <CardDescription>
            Expose the OpenAI-compatible endpoint through Cloudflare.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ToggleSetting
            checked={draft.cloudflareQuickTunnelForCursor}
            disabled={disabled}
            label="Cloudflare Quick Tunnel"
            description="Development only. The hostname changes after helper restarts, and Quick Tunnels do not support SSE."
            onChange={(checked) => update("cloudflareQuickTunnelForCursor", checked)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Management API</CardTitle>
          <CardDescription>
            Override the generated management key used between this plugin and CLIProxyAPI.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label htmlFor="agent-proxy-management-key" className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">Management key override</span>
            <Input
              id="agent-proxy-management-key"
              type="password"
              value={managementKey}
              disabled={disabled || clearManagementKey}
              placeholder={
                saved?.managementKeyConfigured
                  ? "Leave blank to keep the saved override"
                  : "Leave blank to use the generated key"
              }
              autoComplete="off"
              onChange={(event) => setManagementKey(event.target.value)}
            />
          </label>
          {saved?.managementKeyConfigured ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => setClearManagementKey((current) => !current)}
              >
                {clearManagementKey ? "Keep saved override" : "Clear saved override"}
              </Button>
              <span className="text-xs text-muted-foreground">
                {clearManagementKey
                  ? "The generated key will be used after you save."
                  : "A saved override is configured. Its value is never sent to the browser."}
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Core source</CardTitle>
          <CardDescription>
            Choose the public GitHub repository and ref used for update checks and installs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label htmlFor="agent-proxy-source-repository" className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">Repository</span>
            <Input
              id="agent-proxy-source-repository"
              value={draft.sourceRepository}
              disabled={disabled}
              placeholder="owner/repository"
              spellCheck={false}
              onChange={(event) => update("sourceRepository", event.target.value)}
            />
            <span className="block text-xs text-muted-foreground">
              Use owner/name, an HTTPS github.com URL, or a git@github.com source.
            </span>
          </label>

          <label htmlFor="agent-proxy-source-ref" className="block space-y-1.5 text-sm">
            <span className="font-medium text-foreground">Branch or ref</span>
            <Input
              id="agent-proxy-source-ref"
              value={draft.sourceBranch}
              disabled={disabled}
              placeholder="latest"
              spellCheck={false}
              onChange={(event) => update("sourceBranch", event.target.value)}
            />
            <span className="block text-xs text-muted-foreground">
              Use latest for the newest release, or enter a branch, tag, or full commit SHA.
            </span>
          </label>

          <p className="text-xs text-muted-foreground">
            Saving does not replace the running binary. Use Install core on Home after a source
            change.
          </p>
        </CardContent>
      </Card>

      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={reset}>
          Reset to defaults
        </Button>
        {!dirty && saved !== null ? (
          <span className="text-xs text-muted-foreground">All changes are saved.</span>
        ) : null}
      </div>
    </div>
  );
}
