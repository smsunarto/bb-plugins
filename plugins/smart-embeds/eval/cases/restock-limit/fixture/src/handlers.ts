import { changesFor, recordChange } from "./audit.ts";
import { getItem, hasItem, listItems, putItem } from "./store.ts";
import type { ApiResponse, ErrorBody, Item, ItemView } from "./types.ts";

const SKU_PATTERN = /^[A-Z]{3}-[A-Z0-9]{2,6}-\d{2,4}$/;
const MAX_NAME_LENGTH = 120;
const DEFAULT_PAGE_SIZE = 25;
const LOW_STOCK_THRESHOLD = 20;

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(status: number, error: string, detail?: string): ApiResponse<ErrorBody> {
  return { status, body: detail === undefined ? { error } : { error, detail } };
}

export function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function itemView(item: Item): ItemView {
  return {
    sku: item.sku,
    name: item.name,
    quantity: item.quantity,
    available: Math.max(0, item.quantity - item.reserved),
    price: formatPrice(item.priceCents),
    updatedAt: item.updatedAt,
  };
}

export function handleListItems(query: Record<string, string>): ApiResponse {
  const search = (query.q ?? "").trim().toLowerCase();
  const rawLimit = query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
    return fail(400, "invalid_limit", "limit must be a whole number between 1 and 200");
  }

  const matches = listItems().filter((item) => {
    if (search.length === 0) return true;
    return item.sku.toLowerCase().includes(search) || item.name.toLowerCase().includes(search);
  });

  return {
    status: 200,
    body: {
      items: matches.slice(0, rawLimit).map(itemView),
      total: matches.length,
    },
  };
}

export function handleGetItem(sku: string): ApiResponse {
  const item = getItem(sku);
  if (item === undefined) return fail(404, "item_not_found", `no item with sku ${sku}`);
  return { status: 200, body: { item: itemView(item), history: changesFor(item.sku, 10) } };
}

export function handleCreateItem(payload: unknown): ApiResponse {
  if (!isRecord(payload)) return fail(400, "invalid_body", "expected a JSON object");

  const sku = typeof payload.sku === "string" ? payload.sku.trim().toUpperCase() : "";
  if (!SKU_PATTERN.test(sku)) {
    return fail(422, "invalid_sku", "sku must look like ABC-XY12-100");
  }
  if (hasItem(sku)) return fail(409, "sku_taken", `${sku} already exists`);

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return fail(422, "invalid_name", `name must be 1 to ${MAX_NAME_LENGTH} characters`);
  }

  const priceCents = payload.priceCents;
  if (typeof priceCents !== "number" || !Number.isInteger(priceCents) || priceCents < 0) {
    return fail(422, "invalid_price", "priceCents must be a whole number of cents");
  }

  const item: Item = { sku, name, quantity: 0, reserved: 0, priceCents, updatedAt: now() };
  putItem(item);
  recordChange({ sku, action: "create", delta: 0 });
  return { status: 201, body: { item: itemView(item) } };
}

export function handleRestock(sku: string, payload: unknown): ApiResponse {
  const item = getItem(sku);
  if (item === undefined) return fail(404, "item_not_found", `no item with sku ${sku}`);
  if (!isRecord(payload)) return fail(400, "invalid_body", "expected a JSON object");

  const quantity = payload.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity)) {
    return fail(422, "invalid_quantity", "quantity must be a whole number");
  }
  if (quantity <= 0) {
    return fail(422, "invalid_quantity", "quantity must be greater than zero");
  }

  const reference = typeof payload.reference === "string" ? payload.reference.trim() : "";
  const updated: Item = { ...item, quantity: item.quantity + quantity, updatedAt: now() };
  putItem(updated);
  recordChange({ sku, action: "restock", delta: quantity, reference });
  return { status: 200, body: { item: itemView(updated) } };
}

export function handleReserve(sku: string, payload: unknown): ApiResponse {
  const item = getItem(sku);
  if (item === undefined) return fail(404, "item_not_found", `no item with sku ${sku}`);
  if (!isRecord(payload)) return fail(400, "invalid_body", "expected a JSON object");

  const quantity = payload.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
    return fail(422, "invalid_quantity", "quantity must be a whole number above zero");
  }

  const available = item.quantity - item.reserved;
  if (quantity > available) {
    return fail(409, "insufficient_stock", `only ${available} unit(s) left to reserve`);
  }

  const reference = typeof payload.reference === "string" ? payload.reference.trim() : "";
  const updated: Item = { ...item, reserved: item.reserved + quantity, updatedAt: now() };
  putItem(updated);
  recordChange({ sku, action: "reserve", delta: -quantity, reference });
  return { status: 200, body: { item: itemView(updated) } };
}

export function handleRelease(sku: string, payload: unknown): ApiResponse {
  const item = getItem(sku);
  if (item === undefined) return fail(404, "item_not_found", `no item with sku ${sku}`);
  if (!isRecord(payload)) return fail(400, "invalid_body", "expected a JSON object");

  const quantity = payload.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
    return fail(422, "invalid_quantity", "quantity must be a whole number above zero");
  }
  if (quantity > item.reserved) {
    return fail(409, "nothing_to_release", `only ${item.reserved} unit(s) are held`);
  }

  const reference = typeof payload.reference === "string" ? payload.reference.trim() : "";
  const updated: Item = { ...item, reserved: item.reserved - quantity, updatedAt: now() };
  putItem(updated);
  recordChange({ sku, action: "release", delta: quantity, reference });
  return { status: 200, body: { item: itemView(updated) } };
}

export function handleAdjustPrice(sku: string, payload: unknown): ApiResponse {
  const item = getItem(sku);
  if (item === undefined) return fail(404, "item_not_found", `no item with sku ${sku}`);
  if (!isRecord(payload)) return fail(400, "invalid_body", "expected a JSON object");

  const priceCents = payload.priceCents;
  if (typeof priceCents !== "number" || !Number.isInteger(priceCents) || priceCents < 0) {
    return fail(422, "invalid_price", "priceCents must be a whole number of cents");
  }
  // A tenfold jump is nearly always a decimal-point slip in the supplier sheet.
  if (item.priceCents > 0 && priceCents > item.priceCents * 10) {
    return fail(422, "price_jump", "price increase above 10x needs a manual override");
  }

  const updated: Item = { ...item, priceCents, updatedAt: now() };
  putItem(updated);
  recordChange({ sku, action: "price", delta: priceCents - item.priceCents });
  return { status: 200, body: { item: itemView(updated) } };
}

export function handleLowStock(query: Record<string, string>): ApiResponse {
  const raw = query.threshold === undefined ? LOW_STOCK_THRESHOLD : Number(query.threshold);
  if (!Number.isInteger(raw) || raw < 0) {
    return fail(400, "invalid_threshold", "threshold must be a whole number of units");
  }

  const low = listItems()
    .map(itemView)
    .filter((view) => view.available <= raw)
    .sort((left, right) => left.available - right.available);
  return { status: 200, body: { threshold: raw, items: low } };
}
