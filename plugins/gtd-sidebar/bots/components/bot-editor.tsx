import { useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "@bb-plugins/ui/button";
import { Input } from "@bb-plugins/ui/input";
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
import { usePortalScopeProps } from "../../lib/portal-scope";
import { randomAvatar } from "../lib/appearance";
import { AvatarAppearance } from "./avatar-appearance";
import { BotIcon } from "./bot-icon";
import { MEMORY_MAX_CHARS } from "../lib/memory-limit";
import { emptyLaunchPreset, launchPresetSchema, type LaunchPreset } from "../lib/launch-preset";
import { LaunchPresetEditor } from "./launch-preset-editor";

export type HostOption = { id: string; name: string; connected: boolean };
export type ProjectOption = { id: string; name: string };
export type BotEditFields = Pick<
  BotMetadata,
  | "hostId"
  | "name"
  | "role"
  | "avatar"
  | "sectionId"
  | "linkedProjectIds"
  | "soul"
  | "settings"
  | "launchPreset"
> & { ownedProjectIds: string[]; memory?: string };
type ProjectRole = "none" | "member" | "owner";
export type EditorTab = "setup" | "context" | "projects";
export type EditorTarget =
  | { kind: "create" }
  | { kind: "edit"; metadata: BotMetadata; projectOwners: ProjectOwner[]; tab?: EditorTab };

function ownedProjectIdsFor(botId: string, owners: ProjectOwner[]): string[] {
  return owners.filter((owner) => owner.botId === botId).map((owner) => owner.projectId);
}

export function BotEditor({
  target,
  hosts,
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
  const [role, setRole] = useState(editing ? target.metadata.role : "Assistant");
  const [hostId, setHostId] = useState(
    editing
      ? target.metadata.hostId
      : (hosts.find((host) => host.connected)?.id ?? hosts[0]?.id ?? ""),
  );
  const [memory, setMemory] = useState(editing ? target.metadata.memory : "");
  const [launchPreset, setLaunchPreset] = useState<LaunchPreset>(() =>
    editing && target.metadata.launchPreset ? target.metadata.launchPreset : emptyLaunchPreset(),
  );
  const [settingsText, setSettingsText] = useState(
    () => `${JSON.stringify(editing ? target.metadata.settings : {}, null, 2)}\n`,
  );
  const [stateFile, setStateFile] = useState<"SOUL.md" | "MEMORY.md" | "settings.json">("SOUL.md");
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
  const tabsId = useId();
  const tabs = [
    { id: "setup", label: "Bot" },
    { id: "context", label: "Context" },
    {
      id: "projects",
      label: `Projects${linkedProjectIds.length ? ` · ${linkedProjectIds.length}` : ""}`,
    },
  ] as const;
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
        role: role.trim(),
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeEditor();
      }}
    >
      <DialogContent className="bot-editor-dialog flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
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
          <DialogHeader className="shrink-0 px-4 pt-4 pr-10 pb-3">
            <DialogTitle>{editing ? "Edit bot" : "Create bot"}</DialogTitle>
            <DialogDescription>
              An identity, private state, and optional linked projects.
            </DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 items-end gap-3 px-4 pb-3">
            <div className="flex shrink-0 items-center gap-0.5">
              <Popover.Root>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    disabled={pending}
                    className="flex size-14 shrink-0 items-center justify-center rounded-lg hover:bg-state-hover"
                    aria-label="Customize avatar"
                    title="Customize appearance"
                  >
                    <BotIcon avatar={avatar} size={48} label="Bot preview" />
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    {...portalScope}
                    aria-label="Bot appearance"
                    align="start"
                    sideOffset={6}
                    className="z-50 max-h-[60vh] w-72 max-w-[calc(100vw-24px)] overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
                  >
                    <fieldset disabled={pending}>
                      <AvatarAppearance
                        avatar={avatar}
                        onChange={setAvatar}
                        showRandomize={false}
                      />
                    </fieldset>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 text-muted-foreground"
                    disabled={pending}
                    aria-label="Randomize appearance"
                    onClick={() => setAvatar(randomAvatar())}
                  >
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="4" />
                      <g fill="currentColor" stroke="none">
                        <circle cx="8" cy="8" r="1.5" />
                        <circle cx="16" cy="8" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="8" cy="16" r="1.5" />
                        <circle cx="16" cy="16" r="1.5" />
                      </g>
                    </svg>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Randomize appearance</TooltipContent>
              </Tooltip>
            </div>
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-3">
              <label className="min-w-0 space-y-1 text-xs font-medium text-muted-foreground">
                Bot name
                <Input
                  autoFocus
                  className="h-8"
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Research bot"
                />
              </label>
              <label className="min-w-0 space-y-1 text-xs font-medium text-muted-foreground">
                Role
                <Input
                  className="h-8"
                  value={role}
                  maxLength={80}
                  onChange={(event) => setRole(event.target.value)}
                  placeholder="Assistant"
                />
              </label>
            </div>
          </div>
          <div
            role="tablist"
            aria-label="Bot settings"
            className="flex shrink-0 gap-1 border-b border-border px-4"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
              );
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
              setTab(tabs[next]!.id);
              buttons[next]?.focus();
            }}
          >
            {tabs.map((entry) => (
              <button
                key={entry.id}
                id={`${tabsId}-${entry.id}`}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                aria-controls={`${tabsId}-panel`}
                tabIndex={tab === entry.id ? 0 : -1}
                className="min-w-0 flex-1 truncate rounded-t px-1.5 py-2 text-[11px] font-medium text-muted-foreground hover:bg-state-hover aria-selected:bg-state-active aria-selected:text-foreground"
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div
            id={`${tabsId}-panel`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-${tab}`}
            className="bot-editor-panel h-60 min-h-0 overflow-y-auto px-4 py-3"
          >
            {tab === "setup" ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <MachineSelect
                    hosts={hosts}
                    value={hostId}
                    onValueChange={setHostId}
                    disabled={pending}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  State is stored privately in BB. Machine is the default for new conversations.
                </p>
                <LaunchPresetEditor
                  value={launchPreset}
                  onChange={setLaunchPreset}
                  hostId={hostId}
                  disabled={pending}
                />
              </div>
            ) : null}
            {tab === "context" ? (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <select
                    aria-label="Context document"
                    className="h-7 min-w-0 rounded border border-input bg-background px-2 text-xs text-foreground"
                    value={stateFile}
                    onChange={(event) => setStateFile(event.target.value as typeof stateFile)}
                  >
                    <option value="SOUL.md">Instructions · SOUL.md</option>
                    <option value="MEMORY.md">Memory · MEMORY.md</option>
                    <option value="settings.json">Settings · settings.json</option>
                  </select>
                  <span className="text-[10px] text-muted-foreground">
                    {
                      (stateFile === "SOUL.md"
                        ? soul
                        : stateFile === "MEMORY.md"
                          ? memory
                          : settingsText
                      ).length
                    }
                    /
                    {stateFile === "SOUL.md"
                      ? 4096
                      : stateFile === "MEMORY.md"
                        ? MEMORY_MAX_CHARS
                        : 16384}
                  </span>
                </div>
                <textarea
                  aria-label={stateFile}
                  className="min-h-24 w-full flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground"
                  value={
                    stateFile === "SOUL.md"
                      ? soul
                      : stateFile === "MEMORY.md"
                        ? memory
                        : settingsText
                  }
                  maxLength={
                    stateFile === "SOUL.md" ? 4096 : stateFile === "MEMORY.md" ? undefined : 16384
                  }
                  disabled={pending}
                  spellCheck={stateFile === "SOUL.md"}
                  onKeyDown={(event) => event.stopPropagation()}
                  onKeyUp={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    stateFile === "SOUL.md"
                      ? setSoul(event.target.value)
                      : stateFile === "MEMORY.md"
                        ? setMemory(event.target.value)
                        : setSettingsText(event.target.value)
                  }
                  placeholder={
                    stateFile === "SOUL.md"
                      ? "Personality, perspective, and communication style."
                      : undefined
                  }
                />
                {stateFile === "MEMORY.md" && memory.length > MEMORY_MAX_CHARS ? (
                  <p role="status" className="text-xs text-destructive">
                    Memory exceeds 3000 characters. Shorten it before saving a memory change.
                    Existing text is kept.
                  </p>
                ) : null}
                <p className="shrink-0 text-[10px] text-muted-foreground">
                  Private to this bot. Saved together with the bot; don’t store credentials here.
                </p>
              </div>
            ) : null}
            <div hidden={tab !== "projects"}>
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
            </div>
          </div>
          {error ? (
            <p
              role="alert"
              className="max-h-20 shrink-0 overflow-y-auto px-4 pb-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
          <DialogFooter className="shrink-0 border-t border-border px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              disabled={pending || projectPending}
              onClick={closeEditor}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={
                pending || projectPending || projectDraft || !name.trim() || (!editing && !hostId)
              }
            >
              {pending ? "Saving..." : editing ? "Save bot" : "Create bot"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
