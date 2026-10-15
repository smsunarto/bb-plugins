import { useEffect, useId, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  PluginEnvironmentProviderInputsChange,
  PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { slotInputs } from "../shared/slot-contract.ts";
import type { CheckoutSlot } from "../shared/unity-editor-contract.ts";
import { rpc } from "./rpc.ts";

type RegisteredSlot = CheckoutSlot & { lifecycle: NonNullable<CheckoutSlot["lifecycle"]> };

function unavailable(slot: CheckoutSlot) {
  if (slot.lifecycle?.state !== "available") return slot.lifecycle?.state ?? "unregistered";
  if (slot.claims.length) return "Editor claimed";
  if (slot.mainEditors.length || slot.mppmEditors.length) return "Editor open";
  return null;
}

type InventoryState = {
  data?: { hostId: string; slots: CheckoutSlot[] };
  isPending: boolean;
  error: Error | null;
};

function checkoutChoice(
  value: PluginEnvironmentProviderInputsProps["value"],
  projectId: string | null,
  hostId: string | null,
  data: InventoryState["data"],
) {
  const parsed = slotInputs.safeParse(value ?? {});
  const selectedId = parsed.success ? (parsed.data.slotId ?? "") : "invalid-selection";
  const slots =
    data?.hostId === hostId
      ? data.slots.filter(
          (slot): slot is RegisteredSlot =>
            slot.hostId === hostId &&
            slot.lifecycle?.hostId === hostId &&
            slot.lifecycle.projectId === projectId,
        )
      : [];
  return {
    valid: parsed.success,
    selectedId,
    slots,
    selected: slots.find((slot) => slot.lifecycle.id === selectedId),
    available: slots.filter((slot) => unavailable(slot) === null),
  };
}

function blockingReason(
  projectId: string | null,
  hostId: string | null,
  inventory: InventoryState,
  choice: ReturnType<typeof checkoutChoice>,
) {
  if (!projectId) return "Choose a BB project to select a Unity checkout.";
  if (!hostId) return "Choose an existing machine with a registered Unity checkout.";
  if (inventory.isPending) return "Loading Unity checkouts…";
  if (inventory.error) return `Could not load Unity checkouts: ${inventory.error.message}`;
  if (inventory.data?.hostId !== hostId)
    return "The checkout inventory does not match the selected machine. Refresh to try again.";
  if (!choice.valid) return "Choose a Unity checkout again.";
  if (choice.selectedId && !choice.selected)
    return "The selected checkout is no longer registered for this project and machine.";
  if (choice.selected && unavailable(choice.selected))
    return `The selected checkout is unavailable (${unavailable(choice.selected)}). Choose another checkout or wait for it to become available.`;
  if (!choice.selectedId && !choice.available.length)
    return "No Unity checkout is available for this project and machine. Register a checkout or release an existing one.";
  if (!choice.selectedId) return "Choose a checkout before starting this thread.";
  return "";
}

function UnitySlotInputsControl({
  projectId,
  target,
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  const hostId = target.kind === "existing-host" ? target.hostId : null;
  const client = rpc.useClient();
  const inventory = useQuery({
    queryKey: ["game-studio", "unity-checkout-inputs", projectId, hostId],
    queryFn: () => client.listUnityEditors({ hostId: hostId! }),
    enabled: Boolean(projectId && hostId),
    retry: false,
    refetchInterval: 5000,
  });
  const choice = checkoutChoice(value, projectId, hostId, inventory.data);
  const { selectedId, available } = choice;
  const reason = blockingReason(projectId, hostId, inventory, choice);

  const scope = JSON.stringify([projectId, hostId]);
  const reported = useRef("");
  useEffect(() => {
    const next: PluginEnvironmentProviderInputsChange = reason
      ? { status: "blocked", reason }
      : { status: "ready", value: { slotId: selectedId } };
    const key = JSON.stringify([scope, next]);
    if (reported.current === key) return;
    reported.current = key;
    // The SDK requires async inventory changes to publish ready/blocked inputs through onChange.
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent, react-doctor/no-pass-live-state-to-parent
    onChange(next);
  }, [scope, reason, selectedId, onChange]);

  const loading = Boolean(projectId && hostId && inventory.isPending);
  return (
    <CheckoutDisclosure
      choice={choice}
      reason={reason}
      disabled={!projectId || !hostId || loading || Boolean(inventory.error)}
      refreshDisabled={!projectId || !hostId || inventory.isFetching}
      refreshing={inventory.isFetching}
      failed={Boolean(inventory.error)}
      onChoose={(nextId) => {
        if (!available.some((slot) => slot.lifecycle.id === nextId)) return;
        const next: PluginEnvironmentProviderInputsChange = {
          status: "ready",
          value: { slotId: nextId },
        };
        reported.current = JSON.stringify([scope, next]);
        onChange(next);
      }}
      onRefresh={() => void inventory.refetch()}
    />
  );
}

function CheckoutDisclosure({
  choice,
  reason,
  disabled,
  refreshDisabled,
  refreshing,
  failed,
  onChoose,
  onRefresh,
}: {
  choice: ReturnType<typeof checkoutChoice>;
  reason: string;
  disabled: boolean;
  refreshDisabled: boolean;
  refreshing: boolean;
  failed: boolean;
  onChoose: (slotId: string) => void;
  onRefresh: () => void;
}) {
  const id = useId();
  const { selectedId, slots, selected } = choice;
  const basename = selected?.workspacePath.replaceAll("\\", "/").split("/").findLast(Boolean);
  const caption = basename ?? (selectedId ? "Unavailable checkout" : "Choose checkout");
  const blockedSelection = Boolean(selectedId && reason);
  return (
    <details className="gs-app gs-unity-checkout-inputs">
      <summary
        aria-label="Unity checkout"
        title={reason || selected?.workspacePath}
        className={blockedSelection ? "gs-warning" : undefined}
      >
        <span className="gs-unity-checkout-caption">
          {blockedSelection && <span aria-hidden="true">⚠ </span>}
          {caption}
        </span>
        <output
          className="gs-unity-checkout-announcement"
          aria-live={failed ? "assertive" : "polite"}
          aria-atomic="true"
        >
          {reason || `Unity checkout selected: ${selected?.workspacePath}`}
        </output>
      </summary>
      <div className="gs-unity-checkout-panel">
        <label htmlFor={id}>Unity checkout</label>
        <div className="gs-unity-checkout-row">
          <select
            id={id}
            value={selectedId}
            disabled={disabled}
            aria-describedby={`${id}-status`}
            onChange={(event) => onChoose(event.target.value)}
          >
            <option value="" disabled>
              Choose a checkout
            </option>
            {selectedId && !selected && (
              <option value={selectedId} disabled>
                Selected checkout unavailable · {selectedId}
              </option>
            )}
            {slots.map((slot) => (
              <option
                key={slot.lifecycle.id}
                value={slot.lifecycle.id}
                disabled={Boolean(unavailable(slot))}
              >
                {slot.workspacePath} · {unavailable(slot) ?? "available"}
              </option>
            ))}
          </select>
          <button type="button" disabled={refreshDisabled} onClick={onRefresh}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <p id={`${id}-status`}>{reason || selected?.workspacePath}</p>
      </div>
    </details>
  );
}

export function UnitySlotInputs(props: PluginEnvironmentProviderInputsProps) {
  return (
    <PluginQueryBoundary>
      <UnitySlotInputsControl {...props} />
    </PluginQueryBoundary>
  );
}
