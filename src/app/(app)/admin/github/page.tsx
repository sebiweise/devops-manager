import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  ConnectButton,
  RevokeForm,
  StoreTokenForm,
} from "@/components/admin/billing-credential-forms";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { orNotFound } from "@/lib/account-page";
import { param, type SearchParams } from "@/lib/insights-view";
import { requireScope } from "@/server/better-auth/session";
import { listBillingCredentials } from "@/server/data/personal-billing";
import { listInstallations } from "@/server/data/installations";
import { vercelConnectedIds } from "@/server/data/vercel";
import { pageTitle } from "@/lib/page-meta";

export async function generateMetadata() {
  return pageTitle("billingAccess");
}

/** Statuses the Connect callback may report in `?connect=`. */
const CONNECT_STATUSES = [
  "connected",
  "denied",
  "invalid_state",
  "github_error",
  "login_mismatch",
  "not_configured",
  "forbidden",
  "unauthorized",
  "management_disabled",
  "rate_limited",
  "conflict",
  "replayed",
] as const;
type ConnectStatus = (typeof CONNECT_STATUSES)[number];

function connectStatus(value: string | undefined): ConnectStatus | null {
  return (CONNECT_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as ConnectStatus)
    : null;
}

/**
 * Admin only (other roles get 404, design §7 /admin/github): the billing
 * credential of every personal installation, with option A (store a
 * fine-grained PAT), option B (Connect GitHub) and Remove. Statuses never
 * contain a token.
 */
export default async function AdminGitHubPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { scope } = await requireScope();
  const sp = await searchParams;
  const [overview, installations, vercelIds] = await Promise.all([
    orNotFound(listBillingCredentials(scope)),
    listInstallations(scope),
    vercelConnectedIds(scope),
  ]);
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  const connect = connectStatus(param(sp, "connect"));
  const now = new Date();
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium" });
  const ago = (iso: string) => format.relativeTime(new Date(iso), now);
  const billingText = (status: string | null) => {
    if (status === "ok") return t("billingStatus.billed");
    const key = `billingStatus.${status ?? "not_synced"}`;
    return t.has(key as "billingStatus.not_synced")
      ? t(key as "billingStatus.not_synced")
      : (status ?? "—");
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("adminGithub.title")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("adminGithub.intro")}
        </p>
      </div>

      {connect ? (
        <p
          role="status"
          className={
            connect === "connected"
              ? "rounded-md border p-3 text-sm"
              : "rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm"
          }
        >
          {t(`adminGithub.connect.${connect}`)}
        </p>
      ) : null}

      {overview.installations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("adminGithub.none")}</p>
      ) : (
        overview.installations.map((c) => {
          const account = c.accountLogin;
          const hasStored =
            c.state === "pat" ||
            c.state === "connected" ||
            c.state === "reconnect";
          return (
            <Card key={c.installationId}>
              <CardHeader>
                <CardTitle>
                  <h2 className="flex flex-wrap items-center gap-2">
                    {account}
                    <Badge
                      variant={
                        c.state === "reconnect"
                          ? "destructive"
                          : c.state === "none"
                            ? "outline"
                            : "secondary"
                      }
                    >
                      {t(`billingCredential.states.${c.state}`)}
                    </Badge>
                  </h2>
                </CardTitle>
                <CardDescription>
                  <span className="flex flex-col gap-0.5">
                    {c.githubLogin ? (
                      <span>
                        {t("adminGithub.login", { login: c.githubLogin })}
                      </span>
                    ) : null}
                    {c.state === "pat" && c.accessTokenExpiresAt ? (
                      <span>
                        {t("adminGithub.expires", {
                          date: date(c.accessTokenExpiresAt),
                        })}
                      </span>
                    ) : null}
                    {c.state === "connected" && c.refreshTokenExpiresAt ? (
                      <span>
                        {t("adminGithub.refreshExpires", {
                          date: date(c.refreshTokenExpiresAt),
                        })}
                      </span>
                    ) : null}
                    {c.expiringSoon ? (
                      <span className="font-medium text-destructive">
                        {t("billingCredential.expiringSoon", {
                          date: date(
                            (c.state === "pat"
                              ? c.accessTokenExpiresAt
                              : c.refreshTokenExpiresAt) ?? now.toISOString(),
                          ),
                        })}
                      </span>
                    ) : null}
                    {c.lastUsedAt ? (
                      <span>
                        {t("adminGithub.lastUsed", { ago: ago(c.lastUsedAt) })}
                      </span>
                    ) : null}
                    <span>
                      {t("adminGithub.billing", {
                        status: billingText(c.billingStatus),
                      })}{" "}
                      {c.billingSyncedAt
                        ? t("adminGithub.billingSynced", {
                            ago: ago(c.billingSyncedAt),
                          })
                        : t("adminGithub.neverSynced")}
                    </span>
                    {c.lastError ? (
                      <span>
                        {t("adminGithub.lastError", { error: c.lastError })}
                      </span>
                    ) : null}
                  </span>
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                {c.state === "reconnect" ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm"
                  >
                    {t("adminGithub.reconnectBanner")}
                  </p>
                ) : null}
                {c.state === "env" ? (
                  <p className="text-sm text-muted-foreground">
                    {t("adminGithub.envNote")}
                  </p>
                ) : (
                  <div className="grid gap-6 md:grid-cols-2">
                    <section className="flex flex-col gap-2">
                      <h3 className="font-medium">
                        {t("adminGithub.optionA.title")}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {t("adminGithub.optionA.description", { account })}
                      </p>
                      <StoreTokenForm
                        installationId={c.installationId}
                        account={account}
                      />
                    </section>
                    <section className="flex flex-col gap-2">
                      <h3 className="font-medium">
                        {t("adminGithub.optionB.title")}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {t("adminGithub.optionB.description", { account })}
                      </p>
                      {overview.connectEnabled ? (
                        <ConnectButton
                          installationId={c.installationId}
                          reconnect={
                            c.state === "reconnect" || c.state === "connected"
                          }
                        />
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {t("adminGithub.optionB.notConfigured")}
                        </p>
                      )}
                    </section>
                  </div>
                )}
                {hasStored ? (
                  <section className="flex max-w-md flex-col gap-2">
                    <h3 className="font-medium">
                      {t("adminGithub.revoke.title")}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {t("adminGithub.revoke.description")}
                    </p>
                    <RevokeForm
                      installationId={c.installationId}
                      account={account}
                    />
                  </section>
                ) : null}
              </CardContent>
            </Card>
          );
        })
      )}

      {installations.length > 0 ? (
        <section
          aria-labelledby="hosting-overview"
          className="flex flex-col gap-2"
        >
          <h2 id="hosting-overview" className="text-lg font-semibold">
            {t("adminGithub.hosting.title")}
          </h2>
          <table className="w-full max-w-xl text-sm">
            <caption className="sr-only">
              {t("adminGithub.hosting.title")}
            </caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 text-left font-normal">
                  {t("adminGithub.hosting.account")}
                </th>
                <th scope="col" className="py-1 text-left font-normal">
                  {t("adminGithub.hosting.vercel")}
                </th>
              </tr>
            </thead>
            <tbody>
              {installations.map((i) => (
                <tr key={String(i.id)} className="border-t">
                  <td className="py-1.5 pr-2">
                    <Link
                      href={`/o/${encodeURIComponent(i.accountLogin)}/settings#hosting`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {i.accountLogin}
                    </Link>
                  </td>
                  <td className="py-1.5">
                    {vercelIds.has(String(i.id))
                      ? t("adminGithub.hosting.connected")
                      : t("adminGithub.hosting.notConnected")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
