import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { RepoTable } from "@/components/repo-table";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";
import { dashboardRepositories } from "@/server/data/live-repositories";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const { scope } = await requireScope();
  const t = await getTranslations();
  const installations = await dashboardRepositories(scope);
  const isAdmin = hasRole(scope.role, "ADMIN");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("dashboard.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("dashboard.installations", { count: installations.length })}
        </p>
      </div>

      {installations.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("dashboard.empty")}</CardTitle>
            <CardDescription>
              {isAdmin ? t("dashboard.emptyAdmin") : t("dashboard.emptyViewer")}
            </CardDescription>
          </CardHeader>
          {isAdmin ? (
            <CardContent>
              <Link className="underline" href="/onboarding">
                {t("nav.onboarding")}
              </Link>
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      {installations.map(({ installation, repos, source }) => (
        <Card key={installation.id}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link
                href={`/o/${encodeURIComponent(installation.accountLogin)}`}
              >
                {installation.accountLogin}
              </Link>
              <Badge variant="outline">
                {installation.accountType === "ORGANIZATION"
                  ? t("common.organization")
                  : t("common.personalAccount")}
              </Badge>
            </CardTitle>
            <CardDescription>
              {t("dashboard.repositories", { count: repos.length })}
              {" · "}
              {source === "live"
                ? t("dashboard.liveSource")
                : t("dashboard.storedSource")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {repos.length > 0 ? <RepoTable repos={repos} /> : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
