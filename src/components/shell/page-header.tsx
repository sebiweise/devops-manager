import type { ReactNode } from "react";

/**
 * The top of every page (UI overhaul §1.4): the section name as h1, an
 * optional subtitle with counts ("42 repositories · 5 ignored"), an actions
 * slot on the right and an optional InfoLine (a collapsed muted line for
 * sampling or permission notes). Breadcrumbs go above it on detail pages.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  info,
  infoLabel,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Notes behind a disclosure; `infoLabel` is its summary text. */
  info?: ReactNode;
  infoLabel?: string;
}) {
  return (
    <header className="flex flex-col gap-1">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {subtitle ? (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {info && infoLabel ? <InfoLine label={infoLabel}>{info}</InfoLine> : null}
    </header>
  );
}

/** One collapsible muted line. */
export function InfoLine({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer select-none hover:text-foreground">
        {label}
      </summary>
      <div className="mt-1 max-w-prose">{children}</div>
    </details>
  );
}
