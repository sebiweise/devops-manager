import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { activeInstallationIds } from "@/server/authz/scope";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";
import { listInstallations } from "@/server/data/installations";
import { installUrl } from "@/server/github/app";
import { verifyAndStoreInstallation } from "@/server/ingest/discovery";
import { refreshInstallations } from "./actions";
import { pageTitle } from "@/lib/page-meta";

export async function generateMetadata() {
  return pageTitle("onboarding");
}

/**
 * Admin page for installations, and the GitHub App's Setup URL. GitHub sends
 * `?installation_id=…&setup_action=install` here after an install; the id is
 * never trusted: it is checked with `GET /app/installations/{id}` (App JWT)
 * and shown only when it belongs to this App and to an allowed account.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ installation_id?: string; setup_action?: string }>;
}) {
  const { scope } = await requireScope();
  const t = await getTranslations("onboarding");

  if (!hasRole(scope.role, "ADMIN")) {
    return <p className="text-muted-foreground">{t("askAdmin")}</p>;
  }

  const { installation_id: rawId } = await searchParams;
  let verifiedAccount: string | null = null;
  if (rawId !== undefined) {
    if (!/^\d{1,19}$/.test(rawId)) notFound();
    verifiedAccount = await verifyAndStoreInstallation(BigInt(rawId));
    if (!verifiedAccount) notFound();
  }

  // Scope built after a possible verification, so a fresh install shows up.
  const installations = await listInstallations({
    ...scope,
    installationIds: await activeInstallationIds(),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("intro")}</p>
        </div>
        <form action={refreshInstallations}>
          <Button type="submit" variant="outline">
            {t("refresh")}
          </Button>
        </form>
        <Button asChild>
          <a href={installUrl()} rel="noopener noreferrer">
            {t("install")}
          </a>
        </Button>
      </div>

      {verifiedAccount ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          {t("verified", { account: verifiedAccount })}
        </p>
      ) : null}

      {installations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("installHint")}</p>
      ) : null}

      {installations.map((inst) => (
        <Card key={String(inst.id)}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {inst.accountLogin}
              <Badge variant="outline">{inst.accountType}</Badge>
              <Badge variant="secondary">{inst.repositorySelection}</Badge>
              {inst.suspendedAt ? (
                <Badge variant="destructive">{t("suspended")}</Badge>
              ) : null}
            </CardTitle>
            <CardDescription>{t("permissions")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-1">
              {Object.entries(
                (inst.permissions ?? {}) as Record<string, string>,
              )
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, level]) => (
                  <li key={name}>
                    <Badge variant="outline">
                      {name}: {level}
                    </Badge>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
