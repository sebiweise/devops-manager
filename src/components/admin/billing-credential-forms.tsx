"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  revokeBillingCredentialAction,
  startGitHubConnectAction,
  storeBillingTokenAction,
} from "@/server/actions/personal-billing";
import type { CredentialActionResult } from "@/server/billing/personal";

/**
 * Admin forms of one personal installation on /admin/github (design §3.4):
 * option A stores a fine-grained PAT, option B starts "Connect GitHub", and
 * Remove deletes the credential. Store and Remove need the account login
 * typed as confirmation. The token lives only in this form's state until it
 * is submitted; the field is cleared afterwards and the token is never
 * echoed back.
 */

type Result = CredentialActionResult | { status: "failed" };

/** Only GitHub's authorize endpoint is followed. */
export function isAuthorizeUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.host === "github.com" &&
      u.pathname === "/login/oauth/authorize"
    );
  } catch {
    return false;
  }
}

function ResultMessage({ result }: { result: Result | undefined }) {
  const t = useTranslations("billingCredential.results");
  const ta = useTranslations("adminGithub");
  return (
    <p role="status" aria-live="polite" className="text-sm">
      {!result
        ? null
        : result.status === "failed"
          ? ta("failed")
          : t(result.status, { login: result.login ?? "" })}
    </p>
  );
}

export function StoreTokenForm({
  installationId,
  account,
}: {
  installationId: string;
  account: string;
}) {
  const t = useTranslations("adminGithub.optionA");
  const router = useRouter();
  const id = useId();
  const [token, setToken] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<Result>();
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await storeBillingTokenAction({
              installationId,
              token,
              confirmation,
              idempotencyKey: crypto.randomUUID(),
            });
            setResult(res);
            if (res.status === "saved") {
              setConfirmation("");
              router.refresh();
            }
          } catch {
            setResult({ status: "failed" });
          } finally {
            setToken("");
          }
        });
      }}
    >
      <label htmlFor={`${id}-token`} className="text-sm font-medium">
        {t("token")}
      </label>
      <input
        id={`${id}-token`}
        name="token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
        maxLength={512}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="h-9 rounded-md border bg-background px-3 font-mono text-sm"
      />
      <label htmlFor={`${id}-confirm`} className="text-sm font-medium">
        {t("confirm", { account })}
      </label>
      <input
        id={`${id}-confirm`}
        name="confirmation"
        type="text"
        autoComplete="off"
        spellCheck={false}
        required
        maxLength={100}
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
        className="h-9 rounded-md border bg-background px-3 text-sm"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={pending || confirmation.trim() !== account}
        >
          {pending ? t("pending") : t("submit")}
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}

export function ConnectButton({
  installationId,
  reconnect,
}: {
  installationId: string;
  reconnect: boolean;
}) {
  const t = useTranslations("adminGithub.optionB");
  const [result, setResult] = useState<Result>();
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
              const res = await startGitHubConnectAction({ installationId });
              if (res.status === "redirect" && isAuthorizeUrl(res.url)) {
                setResult(res);
                window.location.assign(res.url);
                return;
              }
              setResult(res.status === "redirect" ? { status: "failed" } : res);
            } catch {
              setResult({ status: "failed" });
            }
          })
        }
      >
        {pending ? t("pending") : reconnect ? t("reconnect") : t("submit")}
      </Button>
      <ResultMessage result={result} />
    </div>
  );
}

export function RevokeForm({
  installationId,
  account,
}: {
  installationId: string;
  account: string;
}) {
  const t = useTranslations("adminGithub.revoke");
  const router = useRouter();
  const id = useId();
  const [confirmation, setConfirmation] = useState("");
  const [result, setResult] = useState<Result>();
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await revokeBillingCredentialAction({
              installationId,
              confirmation,
              idempotencyKey: crypto.randomUUID(),
            });
            setResult(res);
            if (res.status === "revoked" || res.status === "revoked_locally") {
              setConfirmation("");
              router.refresh();
            }
          } catch {
            setResult({ status: "failed" });
          }
        });
      }}
    >
      <label htmlFor={`${id}-confirm`} className="text-sm font-medium">
        {t("confirm", { account })}
      </label>
      <input
        id={`${id}-confirm`}
        name="confirmation"
        type="text"
        autoComplete="off"
        spellCheck={false}
        required
        maxLength={100}
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
        className="h-9 rounded-md border bg-background px-3 text-sm"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          disabled={pending || confirmation.trim() !== account}
        >
          {pending ? t("pending") : t("submit")}
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}
