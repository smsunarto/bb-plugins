export type Item = {
  sku: string;
  name: string;
  quantity: number;
  reserved: number;
  priceCents: number;
  updatedAt: string;
};

export type ItemView = {
  sku: string;
  name: string;
  quantity: number;
  available: number;
  price: string;
  updatedAt: string;
};

export type ApiResponse<T = unknown> = {
  status: number;
  body: T;
};

export type ErrorBody = {
  error: string;
  detail?: string;
};

export type ChangeAction = "create" | "restock" | "reserve" | "release" | "price";

export type AuditRecord = {
  sku: string;
  action: ChangeAction;
  delta: number;
  reference: string;
  at: string;
};
