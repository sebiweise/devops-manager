"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { syncNow, type SyncNowResult } from "@/server/actions/sync";

/** Sync now (operator and admin): runs reconcile for one installation. */
export function SyncNowButton({ installationId }: { installationId: string }) {
  const t = useTranslations("sync");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SyncNowResult["status"] | "failed">();

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              const res = await syncNow({
                installationId,
                idempotencyKey: crypto.randomUUID(),
              });
              setResult(res.status);
              if (res.status === "started") router.refresh();
            } catch {
              setResult("failed");
            }
          })
        }
      >
        {pending ? t("running") : t("now")}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        {result ? t(`result.${result}`) : null}
      </p>
    </div>
  );
}
