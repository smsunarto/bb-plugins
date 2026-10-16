import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

/** Keep the distinguishing checkout name visible when its absolute path is long. */
export function CheckoutLabel({ path, machine }: { path: string; machine: string }) {
  const name = path.split(/[\\/]/).findLast(Boolean) ?? path;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="truncate text-sm font-semibold" title={path} translate="no">
        {name}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon name="Laptop" className="size-3 shrink-0" aria-hidden />
        <span className="max-w-[40%] shrink-0 truncate" title={machine}>
          {machine}
        </span>
        <span aria-hidden>·</span>
        <span className="truncate" title={path} translate="no">
          {path}
        </span>
      </span>
    </span>
  );
}
