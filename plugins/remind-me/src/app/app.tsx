import { PluginQueryBoundary, pluginQueryClient } from "@bb-kit/core/rpc/query";
import {
  definePluginApp,
  experimental_Icon as Icon,
  Markdown,
  useBbNavigate,
  useComposer,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { reminderText, type Reminder } from "../shared/reminder.ts";
import { rpc } from "./rpc.ts";
import "./reminders.css";

function ReminderCard({
  reminder,
  onAdd,
}: {
  reminder: Reminder;
  onAdd: (reminder: Reminder) => void;
}) {
  return (
    <article className="rm-card">
      <div className="rm-row">
        <details className="rm-details">
          <summary>
            <Icon name="ChevronRight" className="rm-chevron" aria-hidden />
            <span className="rm-title">{reminder.title}</span>
          </summary>
          <div className="rm-body">
            <Markdown content={reminder.body} />
          </div>
          {reminder.sourceThreadId && (
            <div className="rm-source">
              <Markdown content={`Source: @thread:${reminder.sourceThreadId}`} />
            </div>
          )}
        </details>
        <button
          type="button"
          className="rm-add"
          aria-label={`Add ${reminder.title} to composer`}
          title="Add to composer"
          onClick={() => onAdd(reminder)}
        >
          <Icon name="CornerDownLeft" aria-hidden />
          <span>Add to composer</span>
        </button>
      </div>
      <p className="rm-preview">{reminder.body.replace(/[#*`]/g, "")}</p>
    </article>
  );
}

function useAddToComposer(openCompose: boolean) {
  const composer = useComposer();
  const navigate = useBbNavigate();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  function add(reminder: Reminder) {
    try {
      composer.insert(reminderText(reminder), { at: "end", block: true });
      if (openCompose) navigate.toCompose({ focusPrompt: true });
      else composer.focus();
      setError("");
      setNotice(`Added “${reminder.title}” to composer.`);
    } catch (cause) {
      setNotice("");
      setError(cause instanceof Error ? cause.message : "Could not add reminder to composer.");
    }
  }
  return { add, notice, error };
}

function Reminders({ openCompose = false }: { openCompose?: boolean }) {
  const list = rpc.list.useQuery();
  const connection = useRealtimeConnectionState();
  const [search, setSearch] = useState("");
  const { add, notice, error } = useAddToComposer(openCompose);
  useRealtime("reminders", () => {
    void pluginQueryClient.invalidateQueries({ queryKey: rpc.list.queryKey() });
  });
  // Also recover a save whose realtime notification was missed while disconnected.
  useEffect(() => {
    void pluginQueryClient.invalidateQueries({ queryKey: rpc.list.queryKey() });
  }, [connection]);
  const query = search.trim().toLocaleLowerCase();
  const reminders = list.data?.reminders.filter((item) =>
    `${item.title} ${item.body}`.toLocaleLowerCase().includes(query),
  );
  return (
    <section className="rm-list" aria-label="Saved reminders">
      <div className="rm-intro">
        <p>Saved for later. Add a reminder to your composer when you’re ready.</p>
        <input
          type="search"
          aria-label="Search reminders"
          placeholder="Search reminders…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {list.isPending && <p className="rm-state">Loading reminders…</p>}
      {list.isError && (
        <div role="alert" className="rm-error">
          Could not load reminders.{" "}
          <button type="button" onClick={() => void list.refetch()}>
            Retry
          </button>
        </div>
      )}
      {reminders?.length === 0 && (
        <p className="rm-state">
          {query ? (
            "No matching reminders."
          ) : (
            <>
              Nothing saved yet. Type <code>/remind-me</code> in a conversation to keep a note for
              later.
            </>
          )}
        </p>
      )}
      {reminders?.map((reminder) => (
        <ReminderCard key={reminder.id} reminder={reminder} onAdd={add} />
      ))}
      <output className="rm-notice">{notice}</output>
      {error && (
        <p className="rm-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function RemindersPanel() {
  return (
    <PluginQueryBoundary>
      <Reminders />
    </PluginQueryBoundary>
  );
}
function RemindersPage() {
  return (
    <PluginQueryBoundary>
      <Reminders openCompose />
    </PluginQueryBoundary>
  );
}

function SavedReminder({ id }: { id: string }) {
  const saved = rpc.get.useQuery({ id });
  const { add, notice, error } = useAddToComposer(false);
  if (saved.isPending) return <p className="rm-state">Loading reminder…</p>;
  if (saved.isError)
    return (
      <p className="rm-error" role="alert">
        Could not load reminder.
      </p>
    );
  if (!saved.data.reminder) return <p className="rm-state">Reminder not found.</p>;
  return (
    <div className="rm-inline">
      <ReminderCard reminder={saved.data.reminder} onAdd={add} />
      <output className="rm-notice">{notice}</output>
      {error && (
        <p className="rm-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ReminderDirective({ attributes }: PluginMessageDirectiveProps) {
  return (
    <PluginQueryBoundary>
      <SavedReminder id={attributes.id ?? ""} />
    </PluginQueryBoundary>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "reminders",
    title: "Reminders",
    icon: "Bookmark",
    path: "reminders",
    component: RemindersPage,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "reminders",
    title: "Reminders",
    icon: "Bookmark",
    component: RemindersPanel,
    layout: "flush",
  });
  app.slots.experimental_newThreadPanelAction({
    id: "reminders",
    title: "Reminders",
    icon: "Bookmark",
    component: RemindersPanel,
    layout: "flush",
  });
  app.slots.messageDirective({ id: "reminder", component: ReminderDirective });
});
