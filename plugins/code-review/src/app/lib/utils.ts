import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Scrolls `container` the least it takes to show `element`. Not
 * `scrollIntoView`, which would scroll bb's own layout too.
 */
export function keepInView(container: HTMLElement, element: HTMLElement): void {
  const box = container.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (rect.top < box.top) container.scrollTop -= box.top - rect.top;
  else if (rect.bottom > box.bottom) container.scrollTop += rect.bottom - box.bottom;
}
