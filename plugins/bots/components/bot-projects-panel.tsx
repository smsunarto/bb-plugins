import { useState } from "react";
import type { ProjectOwner } from "../contract";
import { Button } from "@bb-plugins/ui/button";
import { Input } from "@bb-plugins/ui/input";
import { Icon } from "./ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import {
  ProjectCreateForm,
  type ProjectChoice,
  type ProjectCreationActions,
  type ProjectHost,
} from "./project-create-form";

export function BotProjectsPanel({
  projects,
  owners,
  botNames,
  botId,
  botName,
  hostId,
  hosts,
  linkedProjectIds,
  ownedProjectIds,
  onRoleChange,
  onBusyChange,
  onDraftChange,
  onCreateProject,
  onBrowseProjects,
}: ProjectCreationActions & {
  projects: ProjectChoice[];
  owners: ProjectOwner[];
  botNames: Map<string, string>;
  botId: string | null;
  botName: string;
  hostId: string;
  hosts: ProjectHost[];
  linkedProjectIds: string[];
  ownedProjectIds: string[];
  onRoleChange: (projectId: string, role: "none" | "member" | "owner") => void;
  onBusyChange: (busy: boolean) => void;
  onDraftChange: (draft: boolean) => void;
}) {
  const [mode, setMode] = useState<"linked" | "existing" | "create">("linked");
  const [query, setQuery] = useState("");
  const [createdProjects, setCreatedProjects] = useState<ProjectChoice[]>([]);
  const available = [
    ...projects,
    ...createdProjects.filter((created) => !projects.some((project) => project.id === created.id)),
  ];
  const linked = linkedProjectIds.map(
    (id) =>
      available.find((project) => project.id === id) ?? { id, name: `Unavailable project (${id})` },
  );
  const candidates = available.filter(
    (project) =>
      !linkedProjectIds.includes(project.id) &&
      project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  function changeMode(next: typeof mode) {
    setMode(next);
    onDraftChange(next === "create");
  }
  function ownerName(projectId: string) {
    const owner = owners.find((entry) => entry.projectId === projectId && entry.botId !== botId);
    return owner ? (botNames.get(owner.botId) ?? "another bot") : null;
  }
  if (mode === "create")
    return (
      <ProjectCreateForm
        hosts={hosts}
        defaultHostId={hostId}
        defaultName={botName}
        forBot
        onCreateProject={onCreateProject}
        onBrowseProjects={onBrowseProjects}
        onBusyChange={onBusyChange}
        onCancel={() => changeMode("linked")}
        onCreated={(project) => {
          setCreatedProjects((current) => [
            ...current.filter((entry) => entry.id !== project.id),
            project,
          ]);
          onRoleChange(project.id, "owner");
          changeMode("linked");
        }}
      />
    );
  if (mode === "existing")
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">Add existing project</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-muted-foreground"
            onClick={() => changeMode("linked")}
          >
            <Icon name="ChevronLeft" className="size-3.5" />
            Back
          </Button>
        </div>
        <Input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the first field of a dialog the user just opened
          autoFocus
          className="h-8"
          aria-label="Search projects"
          placeholder="Search projects…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
          {candidates.map((project) => (
            <button
              key={project.id}
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover"
              aria-label={`Link ${project.name}`}
              onClick={() => {
                const wasOwned =
                  createdProjects.some((entry) => entry.id === project.id) ||
                  owners.some((entry) => entry.projectId === project.id && entry.botId === botId);
                onRoleChange(project.id, wasOwned ? "owner" : "member");
                changeMode("linked");
              }}
            >
              <span className="min-w-0 truncate">
                {project.name}
                {ownerName(project.id) ? (
                  <span className="block text-[10px] text-muted-foreground">
                    Owned by {ownerName(project.id)}
                  </span>
                ) : null}
              </span>
              <Icon name="Plus" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          ))}
          {!candidates.length ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {query.trim() ? "No matching projects" : "All available projects are already linked."}
            </p>
          ) : null}
        </div>
      </div>
    );
  return (
    <div className="bot-projects-panel space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-xs font-semibold">Linked projects</h3>
          <p className="text-[11px] leading-4 text-muted-foreground">
            The owner receives new project chats. Members join when you pick this bot.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => changeMode("existing")}>
            <Icon name="Search" className="size-3.5" />
            Add existing
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => changeMode("create")}>
            <Icon name="Plus" className="size-3.5" />
            New project
          </Button>
        </div>
      </div>
      {linked.length ? (
        <div className="divide-y divide-border rounded-lg border border-border">
          {linked.map((project) => {
            const otherOwner = ownerName(project.id);
            return (
              <div key={project.id} className="flex items-center gap-2 px-3 py-2">
                <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs" title={project.name}>
                  {project.name}
                  {otherOwner ? (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      Owned by {otherOwner}
                    </span>
                  ) : null}
                </span>
                <Select
                  value={ownedProjectIds.includes(project.id) ? "owner" : "member"}
                  onValueChange={(value) => onRoleChange(project.id, value as "member" | "owner")}
                >
                  <SelectTrigger
                    aria-label={`${project.name} role`}
                    className="h-7 w-28 shrink-0 text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="owner" disabled={Boolean(otherOwner)}>
                      {otherOwner ? `Owner (${otherOwner})` : "Owner"}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground"
                  aria-label={`Unlink ${project.name}`}
                  onClick={() => onRoleChange(project.id, "none")}
                >
                  <Icon name="X" className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Icon name="FolderOpen" className="size-4" />
          </span>
          <p className="text-xs font-medium">No projects linked</p>
          <p className="text-[11px] text-muted-foreground">
            Chats without a project run in this bot’s home folder.
          </p>
        </div>
      )}
      {createdProjects.length ? (
        <p
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a status message, not a form result, which is what <output> means
          role="status"
          className="text-[11px] leading-4 text-muted-foreground"
        >
          New projects are already created. Save the bot to link them; cancelling the bot won’t
          delete them.
        </p>
      ) : null}
    </div>
  );
}
