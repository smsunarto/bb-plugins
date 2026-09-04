import type { Item } from "./types.ts";

const items = new Map<string, Item>();

const SEED: Item[] = [
  {
    sku: "BLT-M6-100",
    name: "M6 bolt, 100 pack",
    quantity: 480,
    reserved: 60,
    priceCents: 1250,
    updatedAt: "2024-04-02T09:14:00.000Z",
  },
  {
    sku: "WSH-M6-500",
    name: "M6 washer, 500 pack",
    quantity: 92,
    reserved: 0,
    priceCents: 2199,
    updatedAt: "2024-04-02T09:14:00.000Z",
  },
  {
    sku: "GRP-RUB-01",
    name: "Rubber grip, black",
    quantity: 14,
    reserved: 12,
    priceCents: 640,
    updatedAt: "2024-04-11T16:40:00.000Z",
  },
];

for (const item of SEED) items.set(item.sku, { ...item });

export function getItem(sku: string): Item | undefined {
  return items.get(sku);
}

export function putItem(item: Item): void {
  items.set(item.sku, item);
}

export function hasItem(sku: string): boolean {
  return items.has(sku);
}

export function listItems(): Item[] {
  return [...items.values()].sort((left, right) => left.sku.localeCompare(right.sku));
}

export function removeItem(sku: string): boolean {
  return items.delete(sku);
}

export function itemCount(): number {
  return items.size;
}
