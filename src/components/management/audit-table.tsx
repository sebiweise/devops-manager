import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditEntryDto } from "@/server/data/audit";

/**
 * Audit entries (design §7 /audit): who triggered an action (app user,
 * role, sign-in provider), the GitHub identity that performed it (the App's
 * bot), the target, the outcome with GitHub's message and request id, and
 * the parameters (redacted values only as hash and length). Bulk parents
 * link to their batch; admins get the Revert batch link.
 */

const statusVariant = {
  SUCCEEDED: "secondary",
  FAILED: "destructive",
  DENIED: "destructive",
  PENDING: "outline",
} as const;

export function AuditTable({
  entries,
  caption,
  batchHref,
  filterHref,
  canRevert,
}: {
  entries: AuditEntryDto[];
  caption: string;
  /** Link to a batch's page (revert preview); null hides batch links. */
  batchHref: ((batchId: string) => string) | null;
  /** Link to the log filtered by a batch or an app user. */
  filterHref: (filter: { batch?: string; actor?: string }) => string;
  canRevert: boolean;
}) {
  const t = useTranslations("management.audit");
  const format = useFormatter();
  if (entries.length === 0)
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("when")}</TableHead>
          <TableHead scope="col">{t("who")}</TableHead>
          <TableHead scope="col">{t("action")}</TableHead>
          <TableHead scope="col">{t("target")}</TableHead>
          <TableHead scope="col">{t("status")}</TableHead>
          <TableHead scope="col">{t("details")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => {
          const isBatch = e.targetType === "batch" && e.batchId;
          return (
            <TableRow key={e.id} className="align-top">
              <TableCell className="text-xs whitespace-nowrap">
                <time dateTime={e.createdAt}>
                  {format.dateTime(new Date(e.createdAt), {
                    dateStyle: "medium",
                    timeStyle: "medium",
                  })}
                </time>
                <span className="block text-muted-foreground">#{e.seq}</span>
              </TableCell>
              <TableCell className="text-xs">
                <Link
                  href={filterHref({ actor: e.actorUserId })}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {e.actorDisplay}
                </Link>
                <span className="block text-muted-foreground">
                  {t("roleVia", {
                    role: e.actorRole.toLowerCase(),
                    provider: e.actorProvider,
                  })}
                </span>
                {e.actingAs ? (
                  <span className="block text-muted-foreground">
                    {t("actingAs", { identity: e.actingAs })}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-xs">
                <span className="font-mono">{e.action}</span>
                {e.batchId ? (
                  <Link
                    href={filterHref({ batch: e.batchId })}
                    className="block text-muted-foreground underline-offset-2 hover:underline"
                  >
                    {isBatch ? t("batchEntries") : t("partOfBatch")}
                  </Link>
                ) : null}
              </TableCell>
              <TableCell className="max-w-56 text-xs break-words">
                {e.repoFullName ? (
                  <span className="block font-medium">{e.repoFullName}</span>
                ) : null}
                <span className="text-muted-foreground">
                  {e.targetType}: {e.targetId}
                </span>
              </TableCell>
              <TableCell className="text-xs">
                <Badge variant={statusVariant[e.status]}>
                  {t(`statusOf.${e.status}`)}
                </Badge>
                {e.httpStatus ? (
                  <span className="block text-muted-foreground">
                    HTTP {e.httpStatus}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="max-w-80 text-xs">
                {e.error ? (
                  <span className="block text-destructive">{e.error}</span>
                ) : null}
                {e.githubRequestId ? (
                  <span className="block text-muted-foreground">
                    {t("requestId", { id: e.githubRequestId })}
                  </span>
                ) : null}
                <details>
                  <summary className="cursor-pointer text-muted-foreground">
                    {t("params")}
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">
                    {JSON.stringify(e.params, null, 2)}
                  </pre>
                </details>
                {isBatch &&
                e.action === "VAR_BULK" &&
                canRevert &&
                batchHref ? (
                  <Link
                    href={batchHref(e.batchId!)}
                    className="mt-1 block font-medium underline"
                  >
                    {t("revertBatch")}
                  </Link>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
