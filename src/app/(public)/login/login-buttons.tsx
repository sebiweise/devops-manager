"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function LoginButtons({
  callbackURL,
  oidcLabel,
  githubLabel,
}: {
  callbackURL: string;
  oidcLabel: string;
  githubLabel: string | null;
}) {
  const [pending, setPending] = useState<string | null>(null);

  async function signIn(provider: "oidc" | "github") {
    setPending(provider);
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL,
      errorCallbackURL: "/login",
    });
    if (error) setPending(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={() => signIn("oidc")} disabled={pending !== null}>
        {oidcLabel}
      </Button>
      {githubLabel ? (
        <Button
          variant="outline"
          onClick={() => signIn("github")}
          disabled={pending !== null}
        >
          {githubLabel}
        </Button>
      ) : null}
    </div>
  );
}
