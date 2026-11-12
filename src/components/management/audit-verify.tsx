"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { verifyAuditChainAction } from "@/server/actions/management";
import type { ChainVerification } from "@/server/audit/chain";

/**
 * The hash-chain Verify button of the audit page (design §7 /audit):
 * recomputes the installation's chain on the server and states whether it
 * is intact, or the first entry where it breaks.
 */

type State = ChainVerification | { status: "denied" } | { status: "error" };

export function AuditVerifyButton({
  installationId,
}: {
  installationId: string;
}) {
  const t = useTranslations("management.audit");
  const [state, setState] = useState<State>();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              const res = await verifyAuditChainAction({ installationId });
              setState("ok" in res ? res : { status: "denied" });
            } catch {
              setState({ status: "error" });
            }
          })
        }
      >
        {pending ? t("verifying") : t("verify")}
      </Button>
      <VerifyResult state={state} />
    </div>
  );
}

export function VerifyResult({ state }: { state: State | undefined }) {
  const t = useTranslations("management.audit");
  let text: string | null = null;
  let broken = false;
  if (state && "ok" in state) {
    if (state.ok) {
      text = t("verifyOk", { count: state.checked });
      if (state.unsealed > 0)
        text += ` ${t("unsealed", { count: state.unsealed })}`;
    } else {
      broken = true;
      text = t("verifyBroken", { seq: state.firstBreak?.seq ?? "?" });
      if (state.firstBreak)
        text += ` ${t(`breakReason.${state.firstBreak.reason}`)}`;
    }
  } else if (state) {
    broken = true;
    text = t(state.status === "denied" ? "verifyDenied" : "verifyError");
  }
  return (
    <p
      role="status"
      aria-live="polite"
      className={broken ? "text-sm font-medium text-destructive" : "text-sm"}
    >
      {text}
    </p>
  );
}
