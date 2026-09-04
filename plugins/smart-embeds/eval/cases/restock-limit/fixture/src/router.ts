import {
  handleAdjustPrice,
  handleCreateItem,
  handleGetItem,
  handleListItems,
  handleLowStock,
  handleRelease,
  handleReserve,
  handleRestock,
} from "./handlers.ts";
import type { ApiResponse } from "./types.ts";

export type Request = {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
};

export function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

export function route(request: Request): ApiResponse {
  const segments = splitPath(request.path);
  const query = request.query ?? {};
  const method = request.method.toUpperCase();

  if (segments[0] !== "items") {
    return { status: 404, body: { error: "unknown_route", detail: request.path } };
  }

  if (segments.length === 1) {
    if (method === "GET") return handleListItems(query);
    if (method === "POST") return handleCreateItem(request.body);
    return { status: 405, body: { error: "method_not_allowed", detail: method } };
  }

  if (segments[1] === "low-stock" && segments.length === 2 && method === "GET") {
    return handleLowStock(query);
  }

  const sku = segments[1] ?? "";
  if (segments.length === 2 && method === "GET") return handleGetItem(sku);

  if (segments.length === 3 && method === "POST") {
    switch (segments[2]) {
      case "restock":
        return handleRestock(sku, request.body);
      case "reserve":
        return handleReserve(sku, request.body);
      case "release":
        return handleRelease(sku, request.body);
      case "price":
        return handleAdjustPrice(sku, request.body);
      default:
        break;
    }
  }

  return { status: 404, body: { error: "unknown_route", detail: request.path } };
}
