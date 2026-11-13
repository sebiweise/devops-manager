"use client";

import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import {
  ActionDialog,
  type DialogControls,
} from "@/components/management/action-dialog";
import { Button } from "@/components/ui/button";
import {
  dailyAllotment,
  deploymentOperations,
  needsTypedName,
  shortSha,
  vercelActionResultText,
  type DeploymentOperation,
  type VercelResultLike,
} from "@/lib/hosting-view";
import { cn } from "@/lib/utils";
import {
  setVercelManagementAction,
  vercelBuildLogAction,
  vercelDeploymentAction,
} from "@/server/actions/vercel";

/**
 * The M6 deployment actions (design addendum §8.2): redeploy, cancel,
 * promote and roll back, each behind a confirmation dialog with a fresh
 * idempotency key; production-affecting ones need the project name typed.
 * Pages render the buttons only while every gate the UI knows of is open
 * (operator role, the three toggles, a healthy connection); the server
 * checks again. The build log excerpt is read live on demand (operators and
 * admins), shown as plain text and kept only in this component's state.
 */

export type ActionDeployment = {
  id: string;
  projectName: string;
  target: string;
  state: string;
  live: boolean;
  rollbackCandidate: boolean;
  commitSha: string | null;
  branch: string | null;
};

export type ActionContext = {
  installationId: string;
  plan: string | null;
  /** Deployments created in the last 24 h (the Hobby allotment's window). */
  last24h: number;
};

function ActionResult({ result }: { result: VercelResultLike | undefined }) {
  const t = useTranslations();
  const text = result ? vercelActionResultText(result) : null;
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

/** The dialog body of one operation (exported for the axe tests). */
export function OperationForm({
  ctx,
  deployment: d,
  operation,
  controls,
}: {
  ctx: ActionContext;
  deployment: ActionDeployment;
  operation: DeploymentOperation;
  controls: DialogControls;
}) {
  const t = useTranslations("hosting.actions");
  const tm = useTranslations("management");
  const [key] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState("");
  const [latest, setLatest] = useState(false);
  const [result, setResult] = useState<VercelResultLike>();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const typedName = needsTypedName(operation, d.target);
  const done = result?.status === "succeeded";
  const cap = dailyAllotment(ctx.plan);
  const destructive = operation === "cancel" || operation === "rollback";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await vercelDeploymentAction({
              installationId: ctx.installationId,
              deploymentId: d.id,
              operation,
              ...(operation === "redeploy" ? { withLatestCommit: latest } : {}),
              confirmed: true,
              ...(typedName ? { typed } : {}),
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
      <p className="text-sm">
        {t(`confirm.${operation}`, {
          target: d.target === "production" ? "production" : "preview",
        })}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("project")}</dt>
        <dd>{d.projectName}</dd>
        <dt className="text-muted-foreground">{t("deployment")}</dt>
        <dd className="font-mono text-xs">{d.id}</dd>
        <dt className="text-muted-foreground">{t("commit")}</dt>
        <dd>
          <span className="font-mono text-xs">
            {shortSha(d.commitSha) ?? "—"}
          </span>{" "}
          <span className="text-xs text-muted-foreground">
            {d.branch ?? ""}
          </span>
        </dd>
        <dt className="text-muted-foreground">{t("target")}</dt>
        <dd>{d.target === "production" ? t("production") : t("preview")}</dd>
      </dl>
      {operation === "redeploy" ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <input
              id={`${id}-latest`}
              type="checkbox"
              checked={latest}
              onChange={(e) => setLatest(e.target.checked)}
            />
            <label htmlFor={`${id}-latest`}>{t("withLatestCommit")}</label>
          </div>
          {d.target === "production" && cap ? (
            <p className="text-xs text-muted-foreground">
              {t("quota", { used: ctx.last24h, cap })}
            </p>
          ) : null}
        </>
      ) : null}
      {operation === "rollback" ? (
        <p className="rounded-md border border-status-warning/60 bg-status-warning/10 p-2 text-sm">
          {t("rollbackWarning")}
        </p>
      ) : null}
      {operation === "promote" ? (
        <p className="text-sm text-muted-foreground">{t("promoteNote")}</p>
      ) : null}
      {typedName ? (
        <label htmlFor={`${id}-typed`} className="flex flex-col gap-1 text-sm">
          <span>{tm("typeToConfirm", { text: d.projectName })}</span>
          <input
            id={`${id}-typed`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 font-mono text-sm"
          />
        </label>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("actingAsNote")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant={destructive ? "destructive" : "default"}
          disabled={
            pending || done || (typedName && typed.trim() !== d.projectName)
          }
        >
          {pending ? t("pending") : t(`op.${operation}`)}
        </Button>
        <ActionResult result={result} />
      </div>
    </form>
  );
}

/** The action buttons of one deployment (operators, all gates open). */
export function DeploymentActions({
  ctx,
  deployment,
  paused = false,
  only,
  compact = false,
}: {
  ctx: ActionContext;
  deployment: ActionDeployment;
  /** The project's production auto-assignment is paused. */
  paused?: boolean;
  /** Show only these operations (e.g. Promote in the W4 banner). */
  only?: DeploymentOperation[];
  compact?: boolean;
}) {
  const t = useTranslations("hosting.actions");
  const ops = deploymentOperations({ ...deployment, paused }).filter(
    (op) => !only || only.includes(op),
  );
  if (ops.length === 0) return null;
  const label = shortSha(deployment.commitSha) ?? deployment.id;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ops.map((op) => (
        <ActionDialog
          key={op}
          trigger={t(`op.${op}`)}
          triggerLabel={t("opFor", {
            op: t(`op.${op}`),
            project: deployment.projectName,
            deployment: label,
          })}
          triggerSize={compact ? "xs" : "sm"}
          triggerVariant={
            op === "cancel" || op === "rollback" ? "destructive" : "outline"
          }
          title={t(`title.${op}`, { project: deployment.projectName })}
        >
          {(controls) => (
            <OperationForm
              ctx={ctx}
              deployment={deployment}
              operation={op}
              controls={controls}
            />
          )}
        </ActionDialog>
      ))}
    </div>
  );
}

type LogLine = {
  at: string | null;
  stream: "out" | "err" | "cmd";
  text: string;
};

/**
 * "Show build log": the newest 200 lines, fetched live from Vercel for
 * operators and admins, scrubbed on the server, shown as plain text and
 * never stored.
 */
export function BuildLogExcerpt({
  installationId,
  deploymentId,
}: {
  installationId: string;
  deploymentId: string;
}) {
  const t = useTranslations("hosting.log");
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = useId();
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-controls={`${id}-log`}
          aria-expanded={lines !== null}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              try {
                const res = await vercelBuildLogAction({
                  installationId,
                  deploymentId,
                });
                if (res.status === "ok") {
                  setLines(res.excerpt.lines);
                  setTruncated(res.excerpt.truncated);
                  setError(null);
                } else {
                  setLines(null);
                  setError(
                    res.status === "failed"
                      ? t("failed", { status: res.httpStatus ?? "—" })
                      : t(
                          res.status === "forbidden" ||
                            res.status === "unauthorized" ||
                            res.status === "unavailable" ||
                            res.status === "rate_limited"
                            ? res.status
                            : "error",
                        ),
                  );
                }
              } catch {
                setError(t("error"));
              }
            })
          }
        >
          {pending ? t("loading") : lines ? t("reload") : t("show")}
        </Button>
        {lines ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setLines(null)}
          >
            {t("hide")}
          </Button>
        ) : null}
        <span role="status" aria-live="polite" className="text-xs">
          {error ? <span className="text-destructive">{error}</span> : null}
        </span>
      </div>
      {lines ? (
        <div id={`${id}-log`} className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {truncated ? t("truncated") : t("note", { count: lines.length })}
          </p>
          {lines.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("empty")}</p>
          ) : (
            <pre
              tabIndex={0}
              aria-label={t("label")}
              className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap"
            >
              {lines.map((l, i) => (
                <span
                  key={i}
                  className={cn(
                    "block",
                    l.stream === "err" && "text-status-critical",
                    l.stream === "cmd" && "font-semibold",
                  )}
                >
                  {l.stream === "cmd" ? "$ " : ""}
                  {l.text || " "}
                </span>
              ))}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ToggleForm({
  installationId,
  teamSlug,
  enabled,
  controls,
}: {
  installationId: string;
  teamSlug: string;
  enabled: boolean;
  controls: DialogControls;
}) {
  const t = useTranslations("vercelSettings.management");
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
            const res = await setVercelManagementAction({
              installationId,
              enabled: !enabled,
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
      <p className="text-sm">{enabled ? t("disableText") : t("enableText")}</p>
      <label htmlFor={id} className="flex flex-col gap-1 text-sm">
        <span>{tm("typeToConfirm", { text: teamSlug })}</span>
        <input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 font-mono text-sm"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant={enabled ? "destructive" : "default"}
          disabled={pending || done || typed.trim() !== teamSlug}
        >
          {enabled ? t("disable") : t("enable")}
        </Button>
        <ActionResult result={result} />
      </div>
    </form>
  );
}

/** The Vercel management toggle (admin, typed team slug). */
export function VercelManagementToggle(props: {
  installationId: string;
  teamSlug: string;
  enabled: boolean;
}) {
  const t = useTranslations("vercelSettings.management");
  return (
    <ActionDialog
      trigger={props.enabled ? t("disable") : t("enable")}
      triggerVariant={props.enabled ? "outline" : "default"}
      title={props.enabled ? t("disableTitle") : t("enableTitle")}
    >
      {(controls) => <ToggleForm {...props} controls={controls} />}
    </ActionDialog>
  );
}
