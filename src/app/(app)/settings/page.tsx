import { getTranslations } from "next-intl/server";
import { LanguageSwitch } from "@/components/language-switch";
import { SignOutButton } from "@/components/sign-out-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireScope } from "@/server/better-auth/session";
import { pageTitle } from "@/lib/page-meta";

export async function generateMetadata() {
  return pageTitle("userSettings");
}

export default async function SettingsPage() {
  const { user, scope } = await requireScope();
  const t = await getTranslations();

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.role")}</CardTitle>
          <CardDescription>
            {t("settings.signedInAs", { email: user.email })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <span className="font-medium">
            {t(`settings.roles.${scope.role}`)}
          </span>
          <SignOutButton label={t("common.signOut")} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("common.language")}</CardTitle>
        </CardHeader>
        <CardContent>
          <LanguageSwitch />
        </CardContent>
      </Card>
    </div>
  );
}
