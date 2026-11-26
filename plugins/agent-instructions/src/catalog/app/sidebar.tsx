import { QueryClientProvider } from "@tanstack/react-query";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Card, CardContent } from "../../../components/ui/card.tsx";
import { EmptyState } from "../../../components/ui/empty-state.tsx";
import { FieldError } from "../../../components/ui/field.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { Item, ItemActions, ItemContent, ItemTitle } from "../../../components/ui/item.tsx";
import { Skeleton } from "../../../components/ui/skeleton.tsx";
import { TooltipProvider } from "../../../components/ui/tooltip.tsx";
import { Hint, UnsavedDot } from "../../app/hint.tsx";
import { queryClient } from "../../app/query.ts";
import { RulesSection } from "../../app/rules.tsx";
import { useRpcQuery } from "../../app/rpc.ts";
import type { CatalogChange, CatalogListing } from "../contract.ts";
import "../../prompts/app/prompt-editor.css";
import { errorsOf, useCatalogChange, useFocusOnMount, usePublish } from "./shared.tsx";
import {
  draftKey,
  draftPaths,
  parseCatalogRoute,
  publishState,
  publishTrouble,
  sameSelection,
  useDraftKeys,
  useGo,
  type CatalogSelection,
  type Deleted,
  type Skill,
} from "./state.ts";

/** The Global tab's sidebar: publish status, docs, rules, skills, and recently deleted entries. */

function Shimmer({ rows }: { rows: number }) {
  return (
    <div className="pe-list" aria-busy="true" aria-label="Loading the catalog">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className="m-2 h-3"
          style={{ width: `${60 + ((index * 23) % 35)}%` }}
        />
      ))}
    </div>
  );
}

function StatusLine({
  listing,
  refreshError,
}: {
  listing: CatalogListing;
  refreshError: string | null;
}) {
  const publish = usePublish();
  const state = publishState(listing.published);
  const shadows = useRpcQuery("catalogShadows", null, { staleTime: 5 * 60_000 });
  const skills = listing.skills.length;
  return (
    <div className="pe-status">
      <div className="pe-status-row">
        <span className="pe-meta">
          {skills} skill{skills === 1 ? "" : "s"} · {listing.docs.length} doc
          {listing.docs.length === 1 ? "" : "s"}
        </span>
        <span className="pe-meta" data-tone={state.tone}>
          {state.text}
        </span>
        {state.tone !== undefined && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            disabled={publish.isPending}
            onClick={() => publish.mutate(null)}
          >
            {publish.isPending ? "Publishing…" : "Publish"}
          </Button>
        )}
      </div>
      {listing.conflicts.length > 0 && (
        <p className="pe-meta" data-tone="warn">
          {listing.conflicts.length} sync conflict{listing.conflicts.length === 1 ? "" : "s"} in{" "}
          conflicts/
        </p>
      )}
      {refreshError !== null && (
        <output className="pe-meta" data-tone="warn">
          Showing the last list; refresh failed: {refreshError}
        </output>
      )}
      {shadows.data?.checked === false && (
        <p className="pe-meta" data-tone="warn">
          Could not check names against bb's skills: {shadows.data.error}
        </p>
      )}
    </div>
  );
}

function matches(filter: string, ...texts: string[]) {
  return filter === "" || texts.some((text) => text.toLowerCase().includes(filter));
}

/**
 * One skill's disclosure. Memoized with primitive props, so typing in the editor
 * or refetching an unchanged listing does not re-render every skill.
 */
const CatalogSkillGroup = memo(function CatalogSkillGroup(props: {
  skill: Skill;
  owner: string | undefined;
  trouble: boolean;
  /** The selected file's path when it belongs to this skill. */
  selectedPath: string | null;
  /** Paths with drafts, NUL-joined (see `draftPaths`). */
  pending: string;
  reveal: boolean;
  onSelect: (selection: CatalogSelection) => void;
}) {
  const { skill, owner, trouble, selectedPath, reveal, onSelect } = props;
  const disclosure = useRef<HTMLDetailsElement>(null);
  const selectedHere = selectedPath !== null;
  useLayoutEffect(() => {
    // Reveal a newly selected file or a filter hit without undoing a manual collapse on refetch.
    if ((selectedHere || reveal) && disclosure.current) disclosure.current.open = true;
  }, [selectedHere, reveal]);
  const pending = props.pending === "" ? [] : props.pending.split("\u0000");
  const known = new Set(skill.files.map((file) => file.path));
  const extra = pending.filter((path) => !known.has(path));
  if (selectedPath !== null && !known.has(selectedPath) && !extra.includes(selectedPath))
    extra.push(selectedPath);
  const row = (path: string, isNew: boolean) => (
    <Item key={path} asChild size="row" className="relative">
      <button
        type="button"
        aria-current={path === selectedPath || undefined}
        onClick={() => onSelect({ skill: skill.name, path })}
      >
        <ItemContent>
          <ItemTitle>{path}</ItemTitle>
        </ItemContent>
        {(isNew || pending.includes(path)) && (
          <ItemActions className="gap-1">
            {isNew && (
              <Badge variant="secondary" className="py-0">
                new
              </Badge>
            )}
            {pending.includes(path) && <UnsavedDot />}
          </ItemActions>
        )}
      </button>
    </Item>
  );
  return (
    <details ref={disclosure} className="pe-skill" data-skill={skill.name}>
      <Hint
        label={
          owner === undefined
            ? skill.description
            : `${skill.description} Shadows: bb also delivers ${skill.name} from ${owner}.`.trim()
        }
      >
        <summary className="pe-skill-summary">
          <span className="pe-summary-line">
            <span className="pe-row-label">{skill.name}</span>
            {!skill.enabled && (
              <Badge variant="outline" className="py-0">
                off
              </Badge>
            )}
            {trouble && (
              <Badge variant="danger" className="py-0">
                clash
              </Badge>
            )}
            {owner !== undefined && (
              <Badge variant="warning" className="py-0">
                shadows
                <span className="sr-only">
                  : bb also delivers {skill.name} from {owner}
                </span>
              </Badge>
            )}
            {pending.length > 0 && <UnsavedDot />}
          </span>
        </summary>
      </Hint>
      <div className="ps-3">
        {skill.files.map((file) => row(file.path, false))}
        {extra.map((path) => row(path, true))}
      </div>
    </details>
  );
});

type FormField = { name: string; label: string; placeholder: string; maxLength: number };

/** A sidebar "+ New …" row that opens a small form in place. */
function InlineForm(props: {
  label: string;
  fields: FormField[];
  submit: string;
  onSubmit: (values: Record<string, string>) => Promise<string[] | null>;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Item asChild size="row">
        <button type="button" onClick={() => setOpen(true)}>
          <ItemTitle>+ {props.label}</ItemTitle>
        </button>
      </Item>
    );
  }
  return <InlineFormFields {...props} onClose={() => setOpen(false)} />;
}

function InlineFormFields(props: {
  label: string;
  fields: FormField[];
  submit: string;
  onSubmit: (values: Record<string, string>) => Promise<string[] | null>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const first = useFocusOnMount<HTMLInputElement>();
  return (
    <Card size="xs" className="my-1">
      <CardContent>
        <form
          className="flex flex-col gap-2"
          aria-label={props.label}
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              const failed = await props.onSubmit(values);
              if (failed === null) props.onClose();
              else setErrors(failed);
            } catch (error) {
              setErrors([(error as Error).message]);
            } finally {
              setBusy(false);
            }
          }}
        >
          {props.fields.map((field, index) => (
            <Input
              key={field.name}
              ref={index === 0 ? first : undefined}
              className="h-8"
              aria-label={field.label}
              placeholder={field.placeholder}
              maxLength={field.maxLength}
              value={values[field.name] ?? ""}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") props.onClose();
              }}
            />
          ))}
          {errors.map((error) => (
            <FieldError key={error} className="break-words">
              {error}
            </FieldError>
          ))}
          <div className="pe-actions justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Creating…" : props.submit}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function DeletedRow({ entry }: { entry: Deleted }) {
  const change = useCatalogChange();
  const [confirm, setConfirm] = useState(false);
  const failed = change.data && change.data.outcome !== "saved" ? errorsOf(change.data) : [];
  const ref = { kind: entry.kind, key: entry.key };
  return (
    <div>
      <Item size="row">
        <ItemContent>
          <ItemTitle>{entry.name}</ItemTitle>
        </ItemContent>
        <ItemActions className="gap-2">
          <Badge variant="outline" className="py-0">
            {entry.kind}
          </Badge>
          {confirm ? (
            <>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-destructive"
                disabled={change.isPending}
                onClick={() => change.mutate({ op: "forget", ...ref })}
              >
                Remove for good
              </Button>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setConfirm(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                disabled={change.isPending}
                onClick={() => change.mutate({ op: "restore", ...ref })}
              >
                Restore
              </Button>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setConfirm(true)}
              >
                Remove
              </Button>
            </>
          )}
        </ItemActions>
      </Item>
      {confirm && (
        <p className="pe-meta pe-wrap px-2 pb-1">This removes the saved copy permanently.</p>
      )}
      {[...failed, ...(change.error ? [change.error.message] : [])].map((error) => (
        <div key={error} className="px-2 pb-1">
          <FieldError className="break-words">{error}</FieldError>
        </div>
      ))}
    </div>
  );
}

function CatalogNav(props: { listing: CatalogListing; subPath: string; filterText: string }) {
  const { listing, subPath, filterText } = props;
  const dirty = useDraftKeys();
  const go = useGo();
  const change = useCatalogChange();
  const shadows = useRpcQuery("catalogShadows", null, { staleTime: 5 * 60_000 });
  const filter = filterText.trim().toLowerCase();
  const selection = parseCatalogRoute(subPath);
  const owners = new Map(
    shadows.data?.checked ? shadows.data.shadows.map((s) => [s.name, s.owner] as const) : [],
  );
  const docs = listing.docs.filter((doc) => matches(filter, doc.name));
  const skills = listing.skills.flatMap((skill) => {
    if (matches(filter, skill.name, skill.description)) return [{ skill, reveal: false }];
    return skill.files.some((file) => matches(filter, file.path)) ? [{ skill, reveal: true }] : [];
  });
  const agentsTrouble =
    listing.published?.ok === true &&
    (listing.published.report.conflicts.includes("AGENTS.md") ||
      listing.published.report.failed.some((f) => f.name === "AGENTS.md"));

  const create = async (op: CatalogChange) => {
    const result = await change.mutateAsync(op);
    if (result.outcome !== "saved") return errorsOf(result);
    return result;
  };

  return (
    <nav className="pe-list" aria-label="Catalog">
      <section className="pe-section" aria-label="Global instructions">
        <h3 className="pe-label">
          Global instructions
          {agentsTrouble && (
            <Badge variant="danger" className="ml-1 py-0 normal-case tracking-normal">
              clash
            </Badge>
          )}
        </h3>
        {docs.map((doc) => {
          const entry = { doc: doc.id };
          return (
            <Item key={doc.id} asChild size="row" className="relative">
              <button
                type="button"
                aria-current={sameSelection(selection, entry) || undefined}
                onClick={() => go(entry)}
              >
                <ItemContent>
                  <ItemTitle>{doc.name}</ItemTitle>
                </ItemContent>
                {(!doc.enabled || dirty.has(draftKey(entry))) && (
                  <ItemActions className="gap-1">
                    {!doc.enabled && (
                      <Badge variant="outline" className="py-0">
                        off
                      </Badge>
                    )}
                    {dirty.has(draftKey(entry)) && <UnsavedDot />}
                  </ItemActions>
                )}
              </button>
            </Item>
          );
        })}
        {listing.docs.length === 0 && (
          <EmptyState className="mx-2 my-1" message="No global instructions yet." />
        )}
        <InlineForm
          label="New doc"
          submit="Create"
          fields={[{ name: "name", label: "Doc name", placeholder: "Doc name", maxLength: 80 }]}
          onSubmit={async ({ name = "" }) => {
            const result = await create({ op: "createDoc", name });
            if (Array.isArray(result)) return result;
            if (result.id) go({ doc: result.id });
            return null;
          }}
        />
      </section>
      <RulesSection subPath={subPath} />
      <section className="pe-section" aria-label="Skills">
        <h3 className="pe-label">Skills</h3>
        {skills.map(({ skill, reveal }) => (
          <CatalogSkillGroup
            key={skill.name}
            skill={skill}
            owner={owners.get(skill.name)}
            trouble={publishTrouble(listing.published, skill.name) !== null}
            selectedPath={
              selection !== null && "skill" in selection && selection.skill === skill.name
                ? selection.path
                : null
            }
            pending={draftPaths(dirty, skill.name)}
            reveal={reveal && filter !== ""}
            onSelect={go}
          />
        ))}
        {filter !== "" && skills.length === 0 && docs.length === 0 && (
          <EmptyState className="mx-2 my-1" message={`Nothing matches “${filterText.trim()}”.`} />
        )}
        <InlineForm
          label="New skill"
          submit="Create"
          fields={[
            { name: "name", label: "Skill name", placeholder: "skill-name", maxLength: 64 },
            {
              name: "description",
              label: "Skill description",
              placeholder: "When agents should use it",
              maxLength: 1024,
            },
          ]}
          onSubmit={async ({ name = "", description = "" }) => {
            const result = await create({ op: "createSkill", name, description });
            if (Array.isArray(result)) return result;
            go({ skill: name.trim(), path: "SKILL.md" });
            return null;
          }}
        />
      </section>
      {listing.deleted.length > 0 && (
        <section className="pe-section" aria-label="Recently deleted">
          <h3 className="pe-label">Recently deleted</h3>
          {listing.deleted.map((entry) => (
            <DeletedRow key={`${entry.kind}:${entry.key}`} entry={entry} />
          ))}
        </section>
      )}
    </nav>
  );
}

function CatalogTabBody({ subPath }: { subPath: string }) {
  const listing = useRpcQuery("catalog", null);
  const [filterText, setFilterText] = useState("");
  if (!listing.data) {
    return (
      <div className="pe-panel pe-sidebar">
        {listing.isError ? (
          <div className="pe-tab-state">
            <Alert variant="destructive" role="alert">
              <AlertDescription>{listing.error.message}</AlertDescription>
            </Alert>
          </div>
        ) : (
          <>
            <div className="pe-status">
              <Skeleton className="m-2 h-3" style={{ width: "70%" }} />
            </div>
            <Shimmer rows={8} />
          </>
        )}
      </div>
    );
  }
  return (
    <div className="pe-panel pe-sidebar">
      {/* Stays below the editor switcher while the long skill list scrolls. */}
      <div className="pe-catalog-head">
        <StatusLine
          listing={listing.data}
          refreshError={listing.isError ? listing.error.message : null}
        />
        <div className="pe-filter">
          <Input
            className="h-8"
            type="search"
            aria-label="Filter the catalog"
            placeholder="Filter docs, skills, and files"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
          />
        </div>
      </div>
      <CatalogNav listing={listing.data} subPath={subPath} filterText={filterText} />
    </div>
  );
}

export function CatalogTab({ subPath }: { subPath: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <CatalogTabBody subPath={subPath} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
