import { useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "@bb-plugins/ui/button";
import { Input } from "@bb-plugins/ui/input";
import { Textarea } from "@bb-plugins/ui/textarea";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./ui/icon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { keepTypingKeys, Field, SectionHeading } from "./editor-fields";
import type { BotAvatar, BotMetadata, ProjectOwner } from "../contract";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { MachineSelect } from "./machine-select";
import { BotProjectsPanel } from "./bot-projects-panel";
import type { ProjectCreationActions } from "./project-create-form";
import { usePortalScopeProps } from "../lib/portal-scope";
import { randomAvatar } from "../lib/appearance";
import { AvatarAppearance } from "./avatar-appearance";
import { BotIcon } from "./bot-icon";
import { MEMORY_MAX_CHARS } from "../lib/memory-limit";
import { emptyLaunchPreset, launchPresetSchema, type LaunchPreset } from "../lib/launch-preset";
import { LaunchPresetEditor } from "./launch-preset-editor";
import { RoutinesPanel } from "./routines-panel";
import { SkillsPanel } from "./skills-panel";

export type HostOption = { id: string; name: string; connected: boolean };
export type ProjectOption = { id: string; name: string };
export type BotEditFields = Pick<
  BotMetadata,
  | "hostId"
  | "name"
  | "avatar"
  | "sectionId"
  | "linkedProjectIds"
  | "soul"
  | "settings"
  | "launchPreset"
> & { ownedProjectIds: string[]; memory?: string };
type ProjectRole = "none" | "member" | "owner";
export type EditorTab = "setup" | "context" | "projects" | "routines" | "skills";
export type EditorTarget =
  | { kind: "create" }
  | { kind: "edit"; metadata: BotMetadata; projectOwners: ProjectOwner[]; tab?: EditorTab };

function ownedProjectIdsFor(botId: string, owners: ProjectOwner[]): string[] {
  return owners.filter((owner) => owner.botId === botId).map((owner) => owner.projectId);
}

/** A new bot's machine: the configured default when listed, else a connected one, else any. */
function newBotHostId(hosts: HostOption[], defaultHostId: string | null): string {
  return (
    hosts.find((host) => host.id === defaultHostId)?.id ??
    hosts.find((host) => host.connected)?.id ??
    hosts[0]?.id ??
    ""
  );
}

export function BotEditor({
  target,
  hosts,
  defaultHostId = null,
  projects,
  bots,
  projectOwners,
  onClose,
  onCreate,
  onUpdate,
  onCreateProject,
  onBrowseProjects,
}: ProjectCreationActions & {
  target: EditorTarget;
  hosts: HostOption[];
  /** A new bot starts on this machine when it is listed. */
  defaultHostId?: string | null;
  projects: ProjectOption[];
  bots: BotMetadata[];
  projectOwners: ProjectOwner[];
  onClose: () => void;
  onCreate: (value: BotEditFields & { hostId: string }) => Promise<void>;
  onUpdate: (value: BotEditFields) => Promise<void>;
}) {
  const editing = target.kind === "edit";
  const botId = editing ? target.metadata.id : null;
  const [name, setName] = useState(editing ? target.metadata.name : "");
  const [hostId, setHostId] = useState(() =>
    editing ? target.metadata.hostId : newBotHostId(hosts, defaultHostId),
  );
  const [memory, setMemory] = useState(editing ? target.metadata.memory : "");
  const [launchPreset, setLaunchPreset] = useState<LaunchPreset>(() =>
    editing && target.metadata.launchPreset ? target.metadata.launchPreset : emptyLaunchPreset(),
  );
  const [settingsText, setSettingsText] = useState(
    () => `${JSON.stringify(editing ? target.metadata.settings : {}, null, 2)}\n`,
  );
  const [stateFile, setStateFile] = useState<ContextDoc>("SOUL.md");
  const portalScope = usePortalScopeProps();
  const initialOwners = editing ? target.projectOwners : projectOwners;
  const [owners] = useState(initialOwners);
  const [botNames] = useState(() => new Map(bots.map((bot) => [bot.id, bot.name])));
  const [ownedProjectIds, setOwnedProjectIds] = useState<string[]>(() =>
    botId ? ownedProjectIdsFor(botId, initialOwners) : [],
  );
  const [linkedProjectIds, setLinkedProjectIds] = useState<string[]>(() => {
    const linked = editing ? target.metadata.linkedProjectIds : [];
    return [...new Set([...linked, ...ownedProjectIdsFor(botId ?? "", initialOwners)])];
  });
  const [projectPending, setProjectPending] = useState(false);
  const [projectDraft, setProjectDraft] = useState(false);
  // Sections are kept for the data, not shown: the Bots shelf does not group by them.
  const sectionId = editing ? target.metadata.sectionId : null;
  const [soul, setSoul] = useState(editing ? target.metadata.soul : "");
  const [avatar, setAvatar] = useState<BotAvatar>(() =>
    editing ? target.metadata.avatar : randomAvatar(),
  );
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>(editing ? (target.tab ?? "setup") : "setup");
  const fieldId = useId();
  function setProjectRole(projectId: string, next: ProjectRole) {
    const otherOwner = owners.find(
      (owner) => owner.projectId === projectId && owner.botId !== botId,
    );
    if (next === "owner" && otherOwner) return;
    setLinkedProjectIds((current) =>
      next === "none"
        ? current.filter((id) => id !== projectId)
        : current.includes(projectId)
          ? current
          : [...current, projectId],
    );
    setOwnedProjectIds((current) =>
      next === "owner"
        ? current.includes(projectId)
          ? current
          : [...current, projectId]
        : current.filter((id) => id !== projectId),
    );
  }
  function closeEditor() {
    if (saving.current || pending || projectPending) return;
    const stateDirty =
      editing &&
      (memory !== target.metadata.memory ||
        settingsText !== `${JSON.stringify(target.metadata.settings, null, 2)}\n` ||
        JSON.stringify(launchPreset) !==
          JSON.stringify(target.metadata.launchPreset ?? emptyLaunchPreset()));
    if (!stateDirty || window.confirm("Discard unsaved bot state changes?")) onClose();
  }
  async function submit() {
    if (saving.current || pending || projectPending || projectDraft) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      const preset = launchPresetSchema.safeParse(launchPreset);
      if (!preset.success) {
        setTab("setup");
        throw new Error(preset.error.issues[0]?.message ?? "Check the new conversation defaults.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(settingsText, (_key, value: unknown) => {
          if (typeof value === "number" && !Number.isFinite(value))
            throw new Error("Settings numbers must be finite");
          return value;
        });
      } catch {
        setTab("context");
        setStateFile("settings.json");
        throw new Error("settings.json must contain valid JSON. Your draft is kept.");
      }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        setTab("context");
        setStateFile("settings.json");
        throw new Error("settings.json must contain a JSON object. Your draft is kept.");
      }
      if (`${JSON.stringify(parsed, null, 2)}\n`.length > 16384) {
        setTab("context");
        setStateFile("settings.json");
        throw new Error(
          "settings.json is too large (maximum 16384 characters). Your draft is kept.",
        );
      }
      const memoryChanged = !editing || memory !== target.metadata.memory;
      if (memoryChanged && memory.length > MEMORY_MAX_CHARS) {
        setTab("context");
        setStateFile("MEMORY.md");
        throw new Error(
          "MEMORY.md must be at most 3000 characters. Shorten your draft before saving; it has been kept.",
        );
      }
      const fields = {
        hostId,
        name: name.trim(),
        avatar,
        sectionId,
        soul,
        ...(memoryChanged ? { memory } : {}),
        settings: parsed as BotMetadata["settings"],
        linkedProjectIds,
        ownedProjectIds,
        launchPreset:
          preset.data.execution || preset.data.initialPrompt || preset.data.workspace !== "checkout"
            ? preset.data
            : null,
      };
      if (target.kind === "edit") await onUpdate(fields);
      else await onCreate({ ...fields, hostId });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  const doc = CONTEXT_DOCS[stateFile];
  const docText =
    stateFile === "SOUL.md" ? soul : stateFile === "MEMORY.md" ? memory : settingsText;
  const busy = pending || projectPending;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeEditor();
      }}
    >
      <DialogContent className="bot-editor-dialog flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Enter in a field saves; the fields themselves are the interactive elements */}
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <DialogHeader className="shrink-0 px-5 pt-5 pr-12 pb-4">
            <DialogTitle>{editing ? `Edit ${target.metadata.name}` : "Create bot"}</DialogTitle>
            <DialogDescription className="text-xs">
              A named assistant with its own instructions, memory, and projects.
            </DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 items-start gap-4 px-5 pb-4">
            <div className="flex shrink-0 flex-col items-center gap-1.5">
              <Popover.Root>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    disabled={pending}
                    className="group relative flex size-16 items-center justify-center rounded-xl border border-border bg-muted/40 transition-colors duration-150 outline-none hover:bg-state-hover hover:duration-0 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-state-active"
                    aria-label="Customize appearance"
                  >
                    <BotIcon avatar={avatar} size={44} label="Bot preview" />
                    <span className="absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-xs group-hover:text-foreground">
                      <Icon name="Pencil" className="size-3" />
                    </span>
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    {...portalScope}
                    aria-label="Bot appearance"
                    align="start"
                    sideOffset={8}
                    className="z-50 max-h-[60vh] w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
                  >
                    <fieldset disabled={pending}>
                      <AvatarAppearance avatar={avatar} onChange={setAvatar} />
                    </fieldset>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                    disabled={pending}
                    onClick={() => setAvatar(randomAvatar())}
                  >
                    <Icon name="Dices" className="size-3.5" />
                    Shuffle
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Random color, shape, and expression</TooltipContent>
              </Tooltip>
            </div>
            <div className="min-w-0 flex-1">
              <Field label="Name" htmlFor={`${fieldId}-name`}>
                <Input
                  id={`${fieldId}-name`}
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- the first field of a dialog the user just opened
                  autoFocus
                  className="h-8"
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Atlas"
                />
              </Field>
            </div>
          </div>
          <Tabs
            value={tab}
            onValueChange={(next) => setTab(next as EditorTab)}
            className="flex min-h-0 shrink flex-col"
          >
            <div className="shrink-0 px-5">
              <TabsList aria-label="Bot settings" className="flex w-full">
                <TabsTrigger value="setup">
                  <Icon name="Settings" className="size-3.5" />
                  General
                </TabsTrigger>
                <TabsTrigger value="context">
                  <Icon name="FileText" className="size-3.5" />
                  Instructions
                </TabsTrigger>
                <TabsTrigger value="projects">
                  <Icon name="Folder" className="size-3.5" />
                  Projects
                  {linkedProjectIds.length ? (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
                      {linkedProjectIds.length}
                    </span>
                  ) : null}
                </TabsTrigger>
                {botId ? (
                  <TabsTrigger value="routines">
                    <Icon name="AlarmClock" className="size-3.5" />
                    Routines
                  </TabsTrigger>
                ) : null}
                {botId ? (
                  <TabsTrigger value="skills">
                    <Icon name="Puzzle" className="size-3.5" />
                    Skills
                  </TabsTrigger>
                ) : null}
              </TabsList>
            </div>
            <div className="bot-editor-panel h-[26rem] min-h-0 shrink overflow-y-auto px-5 py-4">
              <TabsContent value="setup" className="space-y-5">
                <Field
                  label="Machine"
                  detail="Where new conversations run. The bot's state is stored in BB, not on the machine."
                >
                  <div className="max-w-xs">
                    <MachineSelect
                      hosts={hosts}
                      value={hostId}
                      onValueChange={setHostId}
                      disabled={pending}
                      label="Machine"
                      hideLabel
                    />
                  </div>
                </Field>
                <div className="space-y-3">
                  <SectionHeading
                    title="New conversations"
                    detail="Defaults applied when you start a conversation with this bot."
                  />
                  <LaunchPresetEditor
                    value={launchPreset}
                    onChange={setLaunchPreset}
                    hostId={hostId}
                    disabled={pending}
                  />
                </div>
              </TabsContent>
              <TabsContent value="context" className="flex h-full min-h-0 flex-col gap-3">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                  <ToggleGroup
                    type="single"
                    aria-label="Context document"
                    value={stateFile}
                    onValueChange={(next) => {
                      if (next) setStateFile(next as ContextDoc);
                    }}
                  >
                    {CONTEXT_DOC_IDS.map((id) => (
                      <ToggleGroupItem key={id} value={id} title={id}>
                        <Icon name={CONTEXT_DOCS[id].icon} className="size-3.5" />
                        {CONTEXT_DOCS[id].label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <span
                    className={cn(
                      "font-mono text-[10px] tabular-nums text-muted-foreground",
                      docText.length > doc.max && "text-destructive",
                    )}
                  >
                    {stateFile} · {docText.length.toLocaleString()}/{doc.max.toLocaleString()}
                  </span>
                </div>
                <p className="shrink-0 text-[11px] leading-4 text-muted-foreground">{doc.detail}</p>
                <Textarea
                  aria-label={stateFile}
                  className="min-h-32 flex-1 resize-none font-mono text-xs leading-5"
                  value={docText}
                  maxLength={
                    stateFile === "SOUL.md" ? 4096 : stateFile === "MEMORY.md" ? undefined : 16384
                  }
                  disabled={pending}
                  spellCheck={stateFile === "SOUL.md"}
                  onKeyDown={keepTypingKeys}
                  onKeyUp={keepTypingKeys}
                  onChange={(event) =>
                    stateFile === "SOUL.md"
                      ? setSoul(event.target.value)
                      : stateFile === "MEMORY.md"
                        ? setMemory(event.target.value)
                        : setSettingsText(event.target.value)
                  }
                  placeholder={doc.placeholder}
                />
                {stateFile === "MEMORY.md" && memory.length > MEMORY_MAX_CHARS ? (
                  <p
                    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a status message, not a form result, which is what <output> means
                    role="status"
                    className="shrink-0 text-xs text-destructive"
                  >
                    Memory is over 3,000 characters. Shorten it before saving a memory change.
                  </p>
                ) : null}
                <p className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Icon name="Shield" className="size-3.5" />
                  Private to this bot. Don't store credentials here.
                </p>
              </TabsContent>
              <TabsContent value="projects" forceMount hidden={tab !== "projects"}>
                <BotProjectsPanel
                  projects={projects}
                  owners={owners}
                  botNames={botNames}
                  botId={botId}
                  botName={name}
                  hostId={hostId}
                  hosts={hosts}
                  linkedProjectIds={linkedProjectIds}
                  ownedProjectIds={ownedProjectIds}
                  onRoleChange={setProjectRole}
                  onBusyChange={setProjectPending}
                  onDraftChange={setProjectDraft}
                  onCreateProject={onCreateProject}
                  onBrowseProjects={onBrowseProjects}
                />
              </TabsContent>
              {botId ? (
                <TabsContent value="routines">
                  <RoutinesPanel botId={botId} botName={name} />
                </TabsContent>
              ) : null}
              {botId ? (
                <TabsContent value="skills">
                  <SkillsPanel botId={botId} botName={name} />
                </TabsContent>
              ) : null}
            </div>
          </Tabs>
          {error ? (
            <div
              role="alert"
              className="mx-5 mb-3 flex max-h-20 shrink-0 items-start gap-2 overflow-y-auto rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <Icon name="CircleX" className="mt-px size-3.5 shrink-0" />
              {error}
            </div>
          ) : null}
          <DialogFooter className="shrink-0 gap-2 border-t border-border px-5 py-3">
            <Button type="button" variant="outline" disabled={busy} onClick={closeEditor}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={busy || projectDraft || !name.trim() || (!editing && !hostId)}
            >
              {pending ? <Icon name="Loading" className="size-3.5 animate-spin" /> : null}
              {pending ? "Saving…" : editing ? "Save changes" : "Create bot"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ContextDoc = "SOUL.md" | "MEMORY.md" | "settings.json";
const CONTEXT_DOC_IDS = ["SOUL.md", "MEMORY.md", "settings.json"] as const satisfies ContextDoc[];
const CONTEXT_DOCS: Record<
  ContextDoc,
  { label: string; icon: IconName; max: number; detail: string; placeholder?: string }
> = {
  "SOUL.md": {
    label: "Instructions",
    icon: "Sparkles",
    max: 4096,
    detail: "Personality, perspective, and communication style. Sent with every conversation.",
    placeholder:
      "You are Atlas, a careful research assistant. Cite sources and keep answers short.",
  },
  "MEMORY.md": {
    label: "Memory",
    icon: "Brain",
    max: MEMORY_MAX_CHARS,
    detail: "Facts the bot remembers across conversations. The bot adds to it as it works.",
  },
  "settings.json": {
    label: "Settings",
    icon: "Code",
    max: 16384,
    detail: "A JSON object of preferences the bot can read and change.",
  },
};
