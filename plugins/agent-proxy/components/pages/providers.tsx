import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { rpcContract } from "../../server";

type Resource = "claude-api-key" | "codex-api-key" | "gemini-api-key" | "openai-compatibility" | "api-keys";

const SECTIONS: { resource: Resource; title: string; description: string; lineBased: boolean }[] = [
  {
    resource: "api-keys",
    title: "Proxy access keys",
    description: "Keys clients use against the local proxy endpoints. One key per line; the plugin-generated key is always preserved.",
    lineBased: true,
  },
  {
    resource: "claude-api-key",
    title: "Claude API keys",
    description: "Upstream Anthropic API credentials (JSON array of entries).",
    lineBased: false,
  },
  {
    resource: "codex-api-key",
    title: "Codex API keys",
    description: "Upstream OpenAI/Codex API credentials (JSON array of entries).",
    lineBased: false,
  },
  {
    resource: "gemini-api-key",
    title: "Gemini API keys",
    description: "Upstream Google AI Studio credentials (JSON array of entries).",
    lineBased: false,
  },
  {
    resource: "openai-compatibility",
    title: "OpenAI-compatible providers",
    description: "Custom OpenAI-compatible upstreams (JSON array; name, base-url, api-key-entries…).",
    lineBased: false,
  },
];

function ResourceEditor({ resource, title, description, lineBased }: (typeof SECTIONS)[number]) {
  const rpc = useRpc<typeof rpcContract>();
  const [text, setText] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("resourceGet", { resource });
      setText(
        lineBased
          ? result.value.map((entry) => String(entry)).join("\n")
          : JSON.stringify(result.value, null, 2),
      );
      setRevision(result.revision);
      setDirty(false);
    } catch (cause) {
      setText(null);
      setRevision(null);
      toast.error(`${title}: ${String(cause instanceof Error ? cause.message : cause)}`);
    }
  }, [rpc, resource, lineBased, title]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (text === null || revision === null) return;
    let value: unknown[];
    if (lineBased) {
      value = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } else {
      try {
        const parsed: unknown = JSON.parse(text.trim() || "[]");
        if (!Array.isArray(parsed)) throw new Error("must be a JSON array");
        value = parsed;
      } catch (cause) {
        toast.error(`${title}: ${String(cause instanceof Error ? cause.message : cause)}`);
        return;
      }
    }
    setSaving(true);
    try {
      await rpc.call("resourcePut", { resource, value, revision });
      toast.success(`${title} saved`);
      await load();
    } catch (cause) {
      toast.error(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span>{title}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Reload
            </Button>
            <Button size="sm" disabled={saving || !dirty || text === null || revision === null} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </span>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {text === null ? (
          <div className="text-sm text-muted-foreground">Unavailable — is the core running?</div>
        ) : (
          <textarea
            className="min-h-24 w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground focus-visible:outline-none"
            value={text}
            spellCheck={false}
            onChange={(event) => {
              setText(event.target.value);
              setDirty(true);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function ProvidersPage() {
  return (
    <div className="space-y-4">
      {SECTIONS.map((section) => (
        <ResourceEditor key={section.resource} {...section} />
      ))}
    </div>
  );
}
