import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { env } from "@/env";
import { safeNextPath } from "@/lib/safe-redirect";
import { githubLoginEnabled } from "@/server/better-auth/config";
import { getSession } from "@/server/better-auth/session";
import { LoginButtons } from "./login-buttons";

const KNOWN_ERRORS = new Set([
  "no_access",
  "not_in_allowed_group",
  "email_not_verified",
  "provider_disabled",
  "account_not_linked",
]);

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const target = safeNextPath(next) ?? "/dashboard";
  if (!error && (await getSession())) redirect(target);

  const t = await getTranslations("login");
  const errorKey = error ? (KNOWN_ERRORS.has(error) ? error : "default") : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {errorKey ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
            >
              {t(`errors.${errorKey}`)}
            </p>
          ) : null}
          <LoginButtons
            callbackURL={target}
            oidcLabel={t("withProvider", { provider: env.OIDC_PROVIDER_NAME })}
            githubLabel={githubLoginEnabled() ? t("withGithub") : null}
          />
        </CardContent>
      </Card>
    </main>
  );
}
