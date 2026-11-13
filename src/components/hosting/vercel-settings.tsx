"use client";

import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import {
  ActionDialog,
  type DialogControls,
} from "@/components/management/action-dialog";
import { Button } from "@/components/ui/button";
import { vercelResultText, type VercelResultLike } from "@/lib/hosting-view";
import { cn } from "@/lib/utils";
import {
  connectVercelAction,
  disconnectVercelAction,
  linkVercelProjectAction,
  rotateVercelTokenAction,
} from "@/server/actions/vercel";

/**
 * The admin controls of "Hosting · Vercel" (design addendum §5.1, §9):
 * Connect and Rotate (a password field, never echoed; the optional team id
 * is only needed for full-account tokens), Disconnect (type the team slug)
 * and the manual project link. Every control is a confirmation dialog with
 * a fresh idempotency key per opening.
 */

function VercelResult({ result }: { result: VercelResultLike | undefined }) {
  const t = useTranslations();
  const text = result ? vercelResultText(result) : null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn("text-sm", text?.tone === "error" && "text-destructive")}
    >
      {text ? t(text.key, text.values) : null}
    </p>
  );
}

function TokenForm({
  installationId,
  mode,
  controls,
}: {
  installationId: string;
  mode: "connect" | "rotate";
  controls: DialogControls;
}) {
  const t = useTranslations("vercelSettings");
  const [key] = useState(() => crypto.randomUUID());
  const [token, setToken] = useState("");
  const [teamId, setTeamId] = useState("");
  const [result, setResult] = useState<VercelResultLike>();
  const [pending, startTransition] = useTransition();
  const tokenId = useId();
  const teamIdId = useId();
  const done = result?.status === "succeeded";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const action =
              mode === "connect"
                ? connectVercelAction
                : rotateVercelTokenAction;
            const res = await action({
              installationId,
              token,
              teamId: teamId.trim() || undefined,
              confirmed: true,
              idempotencyKey: key,
            });
            setResult(res);
            // The token leaves the form state as soon as it was sent.
            setToken("");
            if (res.status === "succeeded") controls.changed();
          } catch {
            setResult({ status: "error" });
          }
        });
      }}
    >
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t("steps.create")}</li>
        <li>{t("steps.scope")}</li>
        <li>{t("steps.paste")}</li>
      </ol>
      <label htmlFor={tokenId} className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("token")}</span>
        <input
          id={tokenId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={512}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 font-mono text-sm"
        />
      </label>
      <label htmlFor={teamIdId} className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("teamId")}</span>
        <span className="text-xs text-muted-foreground">{t("teamIdHint")}</span>
        <input
          id={teamIdId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          placeholder="team_…"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 font-mono text-sm"
        />
      </label>
      <p className="text-xs text-muted-foreground">{t("fullTokenWarning")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={pending || done || !token.trim()}
        >
          {mode === "connect" ? t("connect") : t("rotate")}
        </Button>
        <VercelResult result={result} />
      </div>
    </form>
  );
}

export function VercelTokenButton({
  installationId,
  mode,
}: {
  installationId: string;
  mode: "connect" | "rotate";
}) {
  const t = useTranslations("vercelSettings");
  return (
    <ActionDialog
      trigger={mode === "connect" ? t("connect") : t("rotate")}
      triggerVariant={mode === "connect" ? "default" : "outline"}
      title={mode === "connect" ? t("connectTitle") : t("rotateTitle")}
    >
      {(controls) => (
        <TokenForm
          installationId={installationId}
          mode={mode}
          controls={controls}
        />
      )}
    </ActionDialog>
  );
}

function DisconnectForm({
  installationId,
  teamSlug,
  envManaged,
  controls,
}: {
  installationId: string;
  teamSlug: string;
  envManaged: boolean;
  controls: DialogControls;
}) {
  const t = useTranslations("vercelSettings");
  const tm = useTranslations("management");
  const [key] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<VercelResultLike>();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const done = result?.status === "succeeded";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await disconnectVercelAction({
              installationId,
              typed,
              idempotencyKey: key,
            });
            setResult(res);
            if (res.status === "succeeded") controls.changed();
          } catch {
            setResult({ status: "error" });
          }
        });
      }}
    >
      <p className="text-sm">{t("disconnectText")}</p>
      {envManaged ? <p className="text-sm">{t("disconnectEnv")}</p> : null}
      <label htmlFor={id} className="flex flex-col gap-1 text-sm">
        <span>{tm("typeToConfirm", { text: teamSlug })}</span>
        <input
          id={id}
          type="text"
          autoComplete="off"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 font-mono text-sm"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          disabled={pending || done || typed.trim() !== teamSlug}
        >
          {t("disconnect")}
        </Button>
        <VercelResult result={result} />
      </div>
    </form>
  );
}

export function VercelDisconnectButton(props: {
  installationId: string;
  teamSlug: string;
  envManaged: boolean;
}) {
  const t = useTranslations("vercelSettings");
  return (
    <ActionDialog trigger={t("disconnect")} title={t("disconnectTitle")}>
      {(controls) => <DisconnectForm {...props} controls={controls} />}
    </ActionDialog>
  );
}

function LinkForm({
  installationId,
  project,
  repositories,
  controls,
}: {
  installationId: string;
  project: { id: string; name: string; manualRepositoryId: string | null };
  repositories: ReadonlyArray<{ id: string; fullName: string }>;
  controls: DialogControls;
}) {
  const t = useTranslations("vercelSettings");
  const [key] = useState(() => crypto.randomUUID());
  const [repo, setRepo] = useState(project.manualRepositoryId ?? "");
  const [result, setResult] = useState<VercelResultLike>();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const done = result?.status === "succeeded";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await linkVercelProjectAction({
              installationId,
              projectId: project.id,
              repositoryId: repo || null,
              confirmed: true,
              idempotencyKey: key,
            });
            setResult(res);
            if (res.status === "succeeded") controls.changed();
          } catch {
            setResult({ status: "error" });
          }
        });
      }}
    >
      <p className="text-sm">{t("linkText", { project: project.name })}</p>
      <label htmlFor={id} className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("linkRepository")}</span>
        <select
          id={id}
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">{t("linkAutomatic")}</option>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || done}>
          {t("linkSave")}
        </Button>
        <VercelResult result={result} />
      </div>
    </form>
  );
}

export function VercelLinkButton(props: {
  installationId: string;
  project: { id: string; name: string; manualRepositoryId: string | null };
  repositories: ReadonlyArray<{ id: string; fullName: string }>;
}) {
  const t = useTranslations("vercelSettings");
  return (
    <ActionDialog
      trigger={t("linkEdit")}
      triggerLabel={t("linkEditFor", { project: props.project.name })}
      triggerSize="xs"
      title={t("linkTitle", { project: props.project.name })}
    >
      {(controls) => <LinkForm {...props} controls={controls} />}
    </ActionDialog>
  );
}
