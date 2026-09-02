// @smsunarto/bb-plugin-gtd-sidebar — an action-oriented replacement for bb's
// sidebar thread list, and a reference for `app.slots.experimental_threadList`.
//
// Active threads are grouped by who acts next. Every section sorts by its most
// recently updated thread.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { ThreadInbox } from "@/components/inbox/thread-inbox";
import { ParentChip } from "@/components/inbox/parent-chip";
import { SubagentsChip } from "@/components/inbox/subagents-chip";
import { RenameThreadAction } from "@/components/inbox/rename-thread-action";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "inbox",
    title: "GTD Sidebar (inbox)",
    description: "Next Action and Waiting, with recent threads first.",
    component: ThreadInbox,
  });

  // Registered first, so it renders on the left of the children chip: the
  // header then reads up (parent) then down (children).
  //
  // The hidden child is otherwise a dead end — it is not in the list, so this
  // chip is its only route back to the parent.
  app.slots.experimental_threadHeaderAction({
    id: "parent",
    title: "Parent thread",
    component: ParentChip,
  });

  // A flat inbox has nowhere to nest child threads, so the list hides them
  // and this chip gives them a home on their parent's header.
  app.slots.experimental_threadHeaderAction({
    id: "children",
    title: "Child threads",
    component: SubagentsChip,
  });

  app.slots.experimental_threadHeaderAction({
    id: "rename-thread",
    title: "Thread name",
    component: RenameThreadAction,
  });
});
