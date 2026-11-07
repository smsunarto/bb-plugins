import { useId, useState } from "react";
import { experimental_useRpcQuery as useRpcQuery } from "@get-bb/plugin-sdk/app";
import { Button } from "@bb-plugins/ui/button";
import { Input } from "@bb-plugins/ui/input";
import { Textarea } from "@bb-plugins/ui/textarea";
import { BOTS_PLUGIN_ID, rpcContract } from "../contract";
import { useBotsRpc } from "../lib/rpc";
import { SKILL_CONTENT_MAX, skillNameSchema, skillTemplate } from "../lib/skill-schema";
import { cn } from "../lib/utils";
import { Field, keepTypingKeys } from "./editor-fields";
import { Icon } from "./ui/icon";

/** A skill being written: `expectedSha256` null creates, a sha256 replaces that revision. */
type Draft = { name: string; content: string; expectedSha256: string | null };

/**
 * A bot's own skills: BB project skills in its home project's `.bb/skills`,
 * so they load only in that bot's home conversations. Changes apply
 * immediately, apart from the editor's Save.
 */
export function SkillsPanel({ botId, botName }: { botId: string; botName: string }) {
  const query = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "skills_list",
    input: { botId },
  });
  const rpc = useBotsRpc();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const skills = query.data?.skills ?? [];
  const who = botName || "the bot";

  async function run(key: string, operation: () => Promise<unknown>) {
    if (pending) return;
    setPending(key);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }
  const edit = (name: string) =>
    run(`${name}:edit`, async () => {
      const skill = await rpc.call("skill_read", { botId, name });
      setDraft({ name, content: skill.content, expectedSha256: skill.sha256 });
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[11px] leading-4 text-muted-foreground">
          Procedures only {who} uses. They live in its home project's <code>.bb/skills</code> and
          load as skills in its conversations there; elsewhere {who} reads them on demand. Changes
          here apply immediately, from each conversation's next session.
        </p>
        {draft ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1"
            disabled={!query.data || Boolean(pending)}
            onClick={() => setDraft({ name: "", content: skillTemplate(""), expectedSha256: null })}
          >
            <Icon name="Plus" className="size-3.5" />
            Add skill
          </Button>
        )}
      </div>
      {draft ? (
        <SkillForm
          key={draft.expectedSha256 ?? "new"}
          draft={draft}
          saving={pending === "save"}
          onCancel={() => setDraft(null)}
          onSave={(value) =>
            void run("save", async () => {
              await rpc.call("skill_save", { botId, ...value });
              setDraft(null);
            })
          }
        />
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <Icon name="CircleX" className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      {query.data === undefined && query.error === null ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading skills">
          {[0, 1].map((index) => (
            <div key={index} className="h-12 animate-pulse rounded-md bg-muted/60" />
          ))}
        </div>
      ) : query.data === undefined ? (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          Skills could not be loaded. The bot's machine may be offline.
          <Button type="button" size="sm" variant="ghost" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : skills.length === 0 && !draft ? (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No skills yet. Add one here, or teach {who} in chat: “Save how we do release notes as a
          skill.”
        </div>
      ) : (
        <ul className="space-y-2">
          {skills.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              pending={pending}
              editing={Boolean(draft)}
              onEdit={() => void edit(skill.name)}
              onDelete={() =>
                void run(`${skill.name}:delete`, () =>
                  rpc.call("skill_delete", { botId, name: skill.name }),
                )
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SkillRow({
  skill,
  pending,
  editing,
  onEdit,
  onDelete,
}: {
  skill: { name: string; description: string };
  pending: string | null;
  editing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const loading = pending === `${skill.name}:edit`;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs font-medium">{skill.name}</span>
        <span className="line-clamp-2 text-[11px] text-muted-foreground">
          {skill.description || "No description"}
        </span>
      </span>
      <span className="flex shrink-0 gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1"
          disabled={Boolean(pending) || editing}
          onClick={onEdit}
        >
          <Icon
            name={loading ? "Loading" : "Pencil"}
            className={cn("size-3.5", loading && "animate-spin")}
          />
          Edit
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-destructive hover:text-destructive"
          aria-label={`Delete ${skill.name}`}
          disabled={Boolean(pending)}
          onClick={() => {
            if (window.confirm(`Delete the skill “${skill.name}” and its folder?`)) onDelete();
          }}
        >
          <Icon name="Trash" className="size-3.5" />
        </Button>
      </span>
    </li>
  );
}

/** Keeps the frontmatter's `name:` in step with the folder name while it still matches. */
function renameFrontmatter(content: string, from: string, to: string) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return content.replace(
    new RegExp(`^(---\\n(?:.*\\n)*?)name:[ \\t]*${escaped}$`, "mu"),
    (_match, head: string) => `${head}name: ${to}`,
  );
}

function SkillForm({
  draft,
  saving,
  onCancel,
  onSave,
}: {
  draft: Draft;
  saving: boolean;
  onCancel: () => void;
  onSave: (value: Draft) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(draft);
  const creating = draft.expectedSha256 === null;
  const nameCheck = skillNameSchema.safeParse(value.name);
  const nameError =
    creating && value.name && !nameCheck.success ? nameCheck.error.issues[0]?.message : null;
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      {creating ? (
        <Field
          label="Name"
          htmlFor={`${id}-name`}
          detail={nameError ?? "The skill's folder and its name: in the frontmatter."}
        >
          <Input
            id={`${id}-name`}
            className="h-8 font-mono text-xs"
            value={value.name}
            maxLength={64}
            placeholder="release-notes"
            aria-invalid={Boolean(nameError)}
            onChange={(event) => {
              const name = event.target.value;
              setValue((current) => ({
                ...current,
                name,
                content: renameFrontmatter(current.content, current.name, name),
              }));
            }}
          />
        </Field>
      ) : (
        <p className="font-mono text-xs font-medium">{value.name}</p>
      )}
      <Field
        label="SKILL.md"
        htmlFor={`${id}-content`}
        detail="Frontmatter description says when to use the skill; the body says how."
        aside={
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {value.content.length.toLocaleString()}/{SKILL_CONTENT_MAX.toLocaleString()}
          </span>
        }
      >
        <Textarea
          id={`${id}-content`}
          className="min-h-48 resize-y font-mono text-xs leading-5"
          value={value.content}
          maxLength={SKILL_CONTENT_MAX}
          spellCheck={false}
          onKeyDown={keepTypingKeys}
          onKeyUp={keepTypingKeys}
          onChange={(event) => setValue((current) => ({ ...current, content: event.target.value }))}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving || !nameCheck.success || !value.content.trim()}
          onClick={() => onSave(value)}
        >
          {saving ? <Icon name="Loading" className="size-3.5 animate-spin" /> : null}
          {creating ? "Create skill" : "Save skill"}
        </Button>
      </div>
    </div>
  );
}
