import type {
  EditTunnel,
  RouteDraft,
  RouteEditor,
  TunnelDetails,
  TunnelTarget,
  TunnelWriteResult,
} from "../shared/schema.ts";
import { TUNNEL_EDITOR } from "./labels.ts";

type EditableRoutes = Extract<RouteEditor, { kind: "editable" }>;
export type RouteRow = { key: string; draft: RouteDraft };
export type TunnelDraft = {
  target: TunnelTarget;
  detail?: TunnelDetails;
  name?: { baseline: string; value: string };
  routes?: { baseline: EditableRoutes; rows: RouteRow[] };
  results: Partial<Record<"rename" | "routes" | "recover", TunnelWriteResult>>;
  activity: "loading" | "rename" | "routes" | "recover" | null;
  reloadRequired: boolean;
  error?: string;
};
export type TunnelClient = {
  tunnelDetails: (target: TunnelTarget) => Promise<TunnelDetails>;
  editTunnel: (input: EditTunnel) => Promise<TunnelWriteResult>;
};
export function targetKey(target: TunnelTarget) {
  return JSON.stringify([target.accountId, target.clientId, target.tunnelId]);
}
function bindingKey(target: Pick<TunnelTarget, "accountId" | "clientId">) {
  return JSON.stringify([target.accountId, target.clientId]);
}
function routeState(baseline: EditableRoutes) {
  return {
    baseline,
    rows: baseline.rules.map((rule) => ({
      key: `existing-${rule.originalIndex}`,
      draft: { kind: "existing" as const, originalIndex: rule.originalIndex, patch: {} },
    })),
  };
}
export function routesDirty(routes: NonNullable<TunnelDraft["routes"]>) {
  return (
    routes.rows.length !== routes.baseline.rules.length ||
    routes.rows.some(
      ({ draft }, i) =>
        draft.kind === "new" ||
        draft.originalIndex !== routes.baseline.rules[i]?.originalIndex ||
        Object.keys(draft.patch).length > 0,
    )
  );
}

function tunnelEdit(
  draft: TunnelDraft,
  section: "rename" | "routes",
): EditTunnel["edit"] | undefined {
  if (section === "rename") {
    if (!draft.name || draft.name.value.trim() === draft.name.baseline || !draft.name.value.trim())
      return;
    return { kind: "rename", expectedName: draft.name.baseline, name: draft.name.value.trim() };
  }
  if (!draft.routes || draft.detail?.routes.kind !== "editable" || !routesDirty(draft.routes))
    return;
  return {
    kind: "routes",
    expectedRevision: draft.routes.baseline.revision,
    routes: draft.routes.rows.map((row) => row.draft),
  };
}

// BB remounts tabs. Keep the entire draft and request lock together until the binding changes.
export class TunnelDraftStore {
  private binding: string | null = null;
  private entries = new Map<string, TunnelDraft>();
  private listeners = new Set<() => void>();
  private version = 0;
  openTunnelId: string | null = null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.version;
  private emit() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
  bind(binding: Pick<TunnelTarget, "accountId" | "clientId"> | null) {
    const key = binding ? bindingKey(binding) : null;
    if (this.binding === key) return;
    this.binding = key;
    this.entries.clear();
    this.openTunnelId = null;
    this.emit();
  }
  get(target: TunnelTarget) {
    return this.entries.get(targetKey(target));
  }
  toggle(target: TunnelTarget) {
    if (this.binding !== bindingKey(target)) return;
    this.openTunnelId = this.openTunnelId === target.tunnelId ? null : target.tunnelId;
    this.emit();
  }
  private put(target: TunnelTarget, draft: TunnelDraft) {
    this.entries.set(targetKey(target), draft);
    this.emit();
  }
  editName(target: TunnelTarget, value: string) {
    const draft = this.get(target);
    if (!draft?.name || draft.activity) return;
    this.put(target, { ...draft, name: { ...draft.name, value } });
  }
  editRoutes(target: TunnelTarget, rows: RouteRow[]) {
    const draft = this.get(target);
    if (!draft?.routes || draft.activity) return;
    this.put(target, { ...draft, routes: { ...draft.routes, rows } });
  }
  private accept(draft: TunnelDraft, detail: TunnelDetails, reset?: "all" | "rename" | "routes") {
    const pendingWrite = detail.writeState.kind === "unconfirmed";
    if (pendingWrite) reset = undefined;
    const keepName =
      draft.name &&
      (pendingWrite || draft.reloadRequired || draft.name.value !== draft.name.baseline);
    const keepRoutes =
      draft.routes && (pendingWrite || draft.reloadRequired || routesDirty(draft.routes));
    return {
      ...draft,
      detail,
      error: undefined,
      name:
        reset === "all" || reset === "rename" || !keepName
          ? { baseline: detail.name, value: detail.name }
          : draft.name,
      routes:
        reset === "all" || reset === "routes" || !keepRoutes
          ? detail.routes.kind === "editable"
            ? routeState(detail.routes)
            : undefined
          : draft.routes,
      reloadRequired: pendingWrite || (reset === "all" ? false : draft.reloadRequired),
      ...(reset === "all" ? { results: {} } : {}),
    };
  }
  async load(target: TunnelTarget, client: TunnelClient, discard = false) {
    if (this.binding !== bindingKey(target)) return;
    const previous = this.get(target);
    if (previous?.activity) return;
    const pending: TunnelDraft = {
      ...(previous ?? { target, results: {}, reloadRequired: false }),
      activity: "loading",
    };
    this.put(target, pending);
    try {
      const detail = await client.tunnelDetails(target);
      if (this.get(target) !== pending) return;
      if (targetKey(detail.target) !== targetKey(target))
        throw new Error(TUNNEL_EDITOR.changedTarget);
      this.put(target, {
        ...this.accept(pending, detail, discard ? "all" : undefined),
        activity: null,
      });
    } catch {
      if (this.get(target) === pending) {
        this.put(target, { ...pending, activity: null, error: TUNNEL_EDITOR.loadFailed });
      }
    }
  }
  async recover(
    target: TunnelTarget,
    client: TunnelClient,
    expectedRecoveryRevision: string,
    acknowledgeRisk: boolean,
  ) {
    const draft = this.get(target);
    const writeState = draft?.detail?.writeState;
    if (
      !acknowledgeRisk ||
      !draft?.detail ||
      draft.detail.owner.kind !== "account" ||
      draft.activity ||
      writeState?.kind !== "unconfirmed" ||
      writeState.recovery?.revision !== expectedRecoveryRevision
    )
      return;
    const pending: TunnelDraft = {
      ...draft,
      activity: "recover",
      reloadRequired: true,
      error: undefined,
    };
    this.put(target, pending);
    let result: TunnelWriteResult;
    try {
      result = await client.editTunnel({
        ...target,
        edit: { kind: "recover", expectedRecoveryRevision, acknowledgeRisk: true },
      });
    } catch {
      result = { kind: "unconfirmed", message: TUNNEL_EDITOR.recoveryLostResponse };
    }
    if (this.get(target) !== pending) return;
    this.put(target, {
      ...pending,
      activity: null,
      detail:
        result.kind === "confirmed"
          ? { ...draft.detail, writeState: { kind: "ready" } }
          : draft.detail,
      results: { ...pending.results, recover: result },
    });
    if (result.kind !== "confirmed") await this.load(target, client);
  }
  async save(target: TunnelTarget, client: TunnelClient, section: "rename" | "routes") {
    const draft = this.get(target);
    if (
      !draft?.detail ||
      draft.activity ||
      draft.reloadRequired ||
      draft.detail.writeState.kind === "unconfirmed" ||
      draft.detail.owner.kind !== "account"
    )
      return;
    const edit = tunnelEdit(draft, section);
    if (!edit) return;
    let pending = { ...draft, activity: section, error: undefined };
    this.put(target, pending);
    let result: TunnelWriteResult;
    try {
      result = await client.editTunnel({ ...target, edit });
    } catch {
      result = { kind: "unconfirmed", message: TUNNEL_EDITOR.lostResponse };
    }
    if (this.get(target) !== pending) return;
    pending = {
      ...pending,
      detail:
        result.kind === "unconfirmed" ? { ...draft.detail, writeState: result } : draft.detail,
      results: { ...pending.results, [section]: result },
      reloadRequired: result.kind === "blocked" || result.kind === "unconfirmed",
    };
    this.put(target, pending);
    if (result.kind === "confirmed") {
      try {
        const detail = await client.tunnelDetails(target);
        if (this.get(target) !== pending) return;
        if (targetKey(detail.target) !== targetKey(target))
          throw new Error(TUNNEL_EDITOR.changedTarget);
        this.put(target, { ...this.accept(pending, detail, section), activity: null });
        return;
      } catch {
        if (this.get(target) !== pending) return;
        this.put(target, {
          ...pending,
          activity: null,
          reloadRequired: true,
          error: TUNNEL_EDITOR.savedRefreshFailed,
        });
        return;
      }
    }
    this.put(target, { ...pending, activity: null });
  }
}
export const tunnelDrafts = new TunnelDraftStore();
