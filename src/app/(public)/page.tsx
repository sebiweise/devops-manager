import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { getSession } from "@/server/better-auth/session";

export default async function LandingPage() {
  if (await getSession()) redirect("/dashboard");
  const t = await getTranslations("landing");
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-20">
      <h1 className="text-4xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-lg text-muted-foreground">{t("intro")}</p>
      <div>
        <Button asChild size="lg">
          <Link href="/login">{t("signIn")}</Link>
        </Button>
      </div>
      <section className="rounded-lg border p-6">
        <h2 className="mb-2 font-medium">{t("privacyTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("privacy")}</p>
        <p className="mt-4 text-sm text-muted-foreground">{t("selfHost")}</p>
      </section>
    </main>
  );
}
