import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Empty states (UI overhaul §1.9): an icon, one sentence and an optional
 * action; the `quiet` variant is a single muted line ("No job waits for
 * approval").
 */
export function EmptyState({
  message,
  action,
  icon: Icon = Inbox,
  quiet = false,
}: {
  message: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  quiet?: boolean;
}) {
  if (quiet) return <p className="text-sm text-muted-foreground">{message}</p>;
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-8 text-center">
      <Icon aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="max-w-prose text-sm text-muted-foreground">{message}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
