import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AlertRepo, AlertRow, Severity } from "@/server/data/dependabot";
import type { PullRow } from "@/server/data/pulls";

/**
 * Dependabot alerts (design §7 /dependabot), read-only: counts by severity ×
 * repo and the alert list with package, ecosystem, GHSA, fixed-in version
 * and the matching open Dependabot PR, linking to GitHub. Severity is
 * always written out, never shown by colour alone.
 */

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

const severityVariant = {
  critical: "destructive",
  high: "destructive",
  medium: "secondary",
  low: "outline",
} as const;

export function SeverityBadge({ severity }: { severity: Severity }) {
  const t = useTranslations("management.dependabot");
  return (
    <Badge variant={severityVariant[severity]}>
      {t(`severity.${severity}`)}
    </Badge>
  );
}

/** The open Dependabot PR of the same repo whose title names the package. */
export function matchingPull(
  alert: Pick<AlertRow, "repositoryId" | "packageName">,
  pulls: readonly PullRow[],
): PullRow | null {
  const pkg = alert.packageName?.toLowerCase();
  if (!pkg) return null;
  return (
    pulls.find(
      (p) =>
        p.isDependabot &&
        p.repositoryId === alert.repositoryId &&
        p.title.toLowerCase().includes(pkg),
    ) ?? null
  );
}

export function SeverityMatrix({
  repos,
  totals,
  caption,
}: {
  repos: AlertRepo[];
  totals: Record<Severity, number>;
  caption: string;
}) {
  const t = useTranslations("management.dependabot");
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("repo")}</TableHead>
          {SEVERITIES.map((s) => (
            <TableHead key={s} scope="col" className="text-right">
              {t(`severity.${s}`)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {repos.map((r) => (
          <TableRow key={r.repositoryId}>
            <TableHead scope="row" className="font-medium">
              {r.fullName}
            </TableHead>
            {r.status === "ok" ? (
              SEVERITIES.map((s) => (
                <TableCell key={s} className="text-right tabular-nums">
                  {r.counts[s]}
                </TableCell>
              ))
            ) : (
              <TableCell colSpan={4} className="text-xs text-muted-foreground">
                {t(`repoStatus.${r.status}`)}
              </TableCell>
            )}
          </TableRow>
        ))}
        <TableRow>
          <TableHead scope="row">{t("total")}</TableHead>
          {SEVERITIES.map((s) => (
            <TableCell key={s} className="text-right font-medium tabular-nums">
              {totals[s]}
            </TableCell>
          ))}
        </TableRow>
      </TableBody>
    </Table>
  );
}

export function AlertsTable({
  alerts,
  pulls = [],
  showRepo = true,
  caption,
}: {
  alerts: AlertRow[];
  pulls?: readonly PullRow[];
  showRepo?: boolean;
  caption: string;
}) {
  const t = useTranslations("management.dependabot");
  if (alerts.length === 0)
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("severityColumn")}</TableHead>
          {showRepo ? <TableHead scope="col">{t("repo")}</TableHead> : null}
          <TableHead scope="col">{t("package")}</TableHead>
          <TableHead scope="col">{t("advisory")}</TableHead>
          <TableHead scope="col">{t("fixedIn")}</TableHead>
          <TableHead scope="col">{t("pull")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {alerts.map((a) => {
          const pr = matchingPull(a, pulls);
          return (
            <TableRow key={`${a.repositoryId}-${a.number}`}>
              <TableCell>
                <SeverityBadge severity={a.severity} />
              </TableCell>
              {showRepo ? (
                <TableCell className="font-medium">{a.repoFullName}</TableCell>
              ) : null}
              <TableCell>
                <span className="font-mono text-xs">
                  {a.packageName ?? "—"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {[a.ecosystem, a.manifestPath].filter(Boolean).join(" · ") ||
                    "—"}
                </span>
              </TableCell>
              <TableCell className="max-w-80">
                {a.htmlUrl ? (
                  <a
                    href={a.htmlUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                    className="underline-offset-2 hover:underline"
                  >
                    {a.ghsaId ?? `#${a.number}`}
                  </a>
                ) : (
                  (a.ghsaId ?? `#${a.number}`)
                )}
                {a.cveId ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    {a.cveId}
                  </span>
                ) : null}
                {a.summary ? (
                  <span className="block text-xs text-muted-foreground">
                    {a.summary}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {a.fixedIn ?? t("noFix")}
              </TableCell>
              <TableCell className="text-xs">
                {pr ? (
                  <a
                    href={pr.url}
                    rel="noopener noreferrer"
                    target="_blank"
                    className="underline"
                  >
                    #{pr.number}
                  </a>
                ) : (
                  "—"
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
