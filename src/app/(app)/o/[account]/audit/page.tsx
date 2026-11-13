import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AuditTable } from "@/components/management/audit-table";
import { AuditVerifyButton } from "@/components/management/audit-verify";
import { Button } from "@/components/ui/button";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  AUDIT_ACTIONS,
  AUDIT_STATUSES,
  parseAuditQuery,
} from "@/lib/audit-view";
import { withParams, type SearchParams } from "@/lib/insights-view";
import { hasRole } from "@/server/authz/roles";
import { INSTANCE_CHAIN, listAuditEntries } from "@/server/data/audit";
import { listRepoTargets } from "@/server/data/management";
import { accountMeta } from "@/lib/page-meta";

export const generateMetadata = accountMeta("audit");

/**
 * The audit log of an installation (design §7 /audit). Every role sees the
 * chain of every visible installation; the instance-level chain (roles,
 * SkuRate, billing credentials) and the Revert batch links are for admins
 * only. Filters live in the URL; Verify recomputes the hash chain and the
 * CSV export uses the same filters.
 */
export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const isAdmin = hasRole(scope.role, "ADMIN");
  const query = parseAuditQuery(sp);
  const instance = query.chain === "instance" && isAdmin;
  const chain = instance ? INSTANCE_CHAIN : installation.id;
  const [t, page, repos] = await Promise.all([
    getTranslations("management.audit"),
    orNotFound(
      listAuditEntries(scope, chain, query.filter, {
        before: query.before,
        limit: 50,
      }),
    ),
    orNotFound(
      listRepoTargets(scope, installation.id, { includeIgnored: true }),
    ),
  ]);
  const login = installation.accountLogin;
  const base = accountPath(login, "/audit");
  const current: SearchParams = {
    ...query.values,
    ...(instance ? { chain: "instance" } : {}),
  };
  const field = "h-9 rounded-md border bg-background px-2 text-sm";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">
            {instance ? t("instanceTitle") : t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={withParams(`${base}/export`, current, {})}
            className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent"
            download
          >
            {t("exportCsv")}
          </a>
        </div>
      </div>

      <AuditVerifyButton installationId={String(chain)} />

      {isAdmin ? (
        <nav aria-label={t("chains")} className="flex gap-1 text-sm">
          <Link
            href={withParams(base, {}, {})}
            aria-current={!instance ? "page" : undefined}
            className={
              !instance
                ? "rounded-md bg-accent px-3 py-1.5 font-medium"
                : "rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent"
            }
          >
            {t("installationChain")}
          </Link>
          <Link
            href={withParams(base, {}, { chain: "instance" })}
            aria-current={instance ? "page" : undefined}
            className={
              instance
                ? "rounded-md bg-accent px-3 py-1.5 font-medium"
                : "rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent"
            }
          >
            {t("instanceChain")}
          </Link>
        </nav>
      ) : null}

      <form
        method="get"
        action={base}
        className="flex flex-wrap items-end gap-3 rounded-lg border p-3"
        aria-label={t("filters")}
      >
        {instance ? (
          <input type="hidden" name="chain" value="instance" />
        ) : null}
        {query.values.actor ? (
          <input type="hidden" name="actor" value={query.values.actor} />
        ) : null}
        {query.values.batch ? (
          <input type="hidden" name="batch" value={query.values.batch} />
        ) : null}
        {query.values.entry ? (
          <input type="hidden" name="entry" value={query.values.entry} />
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor="audit-action" className="text-xs font-medium">
            {t("action")}
          </label>
          <select
            id="audit-action"
            name="action"
            defaultValue={query.values.action ?? ""}
            className={field}
          >
            <option value="">{t("any")}</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`actionLabel.${a}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="audit-status" className="text-xs font-medium">
            {t("status")}
          </label>
          <select
            id="audit-status"
            name="status"
            defaultValue={query.values.status ?? ""}
            className={field}
          >
            <option value="">{t("any")}</option>
            {AUDIT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statusOf.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {!instance ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="audit-repo" className="text-xs font-medium">
              {t("repo")}
            </label>
            <select
              id="audit-repo"
              name="repo"
              defaultValue={query.values.repo ?? ""}
              className={field}
            >
              <option value="">{t("any")}</option>
              {repos.map((r) => (
                <option key={String(r.id)} value={String(r.id)}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor="audit-from" className="text-xs font-medium">
            {t("from")}
          </label>
          <input
            id="audit-from"
            type="date"
            name="from"
            defaultValue={query.values.from}
            className={field}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="audit-to" className="text-xs font-medium">
            {t("to")}
          </label>
          <input
            id="audit-to"
            type="date"
            name="to"
            defaultValue={query.values.to}
            className={field}
          />
        </div>
        <Button type="submit" size="sm" variant="outline">
          {t("apply")}
        </Button>
        <Link
          href={withParams(base, instance ? { chain: "instance" } : {}, {})}
          className="text-sm underline"
        >
          {t("reset")}
        </Link>
      </form>

      {query.values.actor || query.values.batch || query.values.entry ? (
        <p className="text-sm text-muted-foreground">
          {query.values.entry
            ? t("filteredEntry")
            : query.values.batch
              ? t("filteredBatch", { batch: query.values.batch })
              : t("filteredActor")}{" "}
          <Link
            className="underline"
            href={withParams(base, current, {
              actor: undefined,
              batch: undefined,
              entry: undefined,
            })}
          >
            {t("clearFilter")}
          </Link>
        </p>
      ) : null}

      <AuditTable
        entries={page.entries}
        caption={instance ? t("instanceTitle") : t("title")}
        batchHref={
          instance
            ? null
            : (batchId) =>
                accountPath(
                  login,
                  `/variables/batches/${encodeURIComponent(batchId)}`,
                )
        }
        filterHref={(f) =>
          withParams(base, current, {
            before: undefined,
            ...(f.batch ? { batch: f.batch } : {}),
            ...(f.actor ? { actor: f.actor } : {}),
          })
        }
        canRevert={isAdmin && !instance}
      />

      <div className="flex gap-3 text-sm">
        {query.before ? (
          <Link className="underline" href={withParams(base, current, {})}>
            {t("newest")}
          </Link>
        ) : null}
        {page.nextBefore ? (
          <Link
            className="underline"
            href={withParams(base, current, { before: page.nextBefore })}
          >
            {t("older")}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
