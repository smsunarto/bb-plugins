import { useState } from "react";

/**
 * The latest defined value. A cached read keyed by its input starts empty
 * when the input changes; this keeps the last answer on screen until the new
 * one lands.
 */
export function useRetained<T>(value: T | undefined): T | undefined {
  const [retained, setRetained] = useState(value);
  if (value !== undefined && value !== retained) setRetained(value);
  return value ?? retained;
}
