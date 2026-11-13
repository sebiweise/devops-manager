"use client";

import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import {
  ActionDialog,
  type DialogControls,
} from "@/components/management/action-dialog";
import { Button } from "@/components/ui/button";
import { runWarning } from "@/lib/azure-usage";
import {
  azureOperations,
  azureResultText,
  type AzureResultLike,
} from "@/lib/azure-view";
import { cn } from "@/lib/utils";
import {
  azureBuildAction,
  azureLogAction,
  queueAzureRunAction,
  setAzureManagementAction,
} from "@/server/actions/azure";

/**
 * The M7b Azure Pipelines actions (design addendum §7.2): queue a run,
 * cancel, retry a build and retry a stage, each behind a confirmation
 * dialog with a fresh idempotency key. The dialogs show the minutes left,
 * the definition's p90 and the parallel job state, and warn when the run
 * may not fit (blocking when the admin turned that on; the server checks
 * again). Pages render the buttons only while every gate the UI knows of
 * is open. The job log excerpt is read live and kept only in this state.
 */

export type AzureActionContext = {
  installationId: string;
  minutesLeft: number | null;
  maxJobMinutes: number;
  running: number;
  limit: number;
  blockWhenQuotaExhausted: boolean;
};

export function AzureResult({
  result,
}: {
  result: AzureResultLike | undefined;
}) {
  const t = useTranslations();
  const text = result ? azureResultText(result) : null;
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

/** Minutes left, p90 and parallel slots, with the quota and job-cap warnings. */
function QuotaNote({
  ctx,
  p90Minutes,
}: {
  ctx: AzureActionContext;
  p90Minutes: number | null;
}) {
  const t = useTranslations("ci.azure.actions");
  const w = runWarning({
    minutesLeft: ctx.minutesLeft,
    p90Minutes,
    maxJobMinutes: ctx.maxJobMinutes,
  });
  return (
    <div className="flex flex-col gap-1 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{t("minutesLeft")}</dt>
        <dd>{ctx.minutesLeft == null ? t("unlimited") : ctx.minutesLeft}</dd>
        <dt className="text-muted-foreground">{t("p90")}</dt>
        <dd>{p90Minutes == null ? "—" : t("minutes", { n: p90Minutes })}</dd>
        <dt className="text-muted-foreground">{t("parallel")}</dt>
        <dd>
          {t("slots", { running: ctx.running, limit: ctx.limit })}
          {ctx.running >= ctx.limit ? (
            <span className="block text-xs text-muted-foreground">
              {t("willQueue")}
            </span>
          ) : null}
        </dd>
      </dl>
      {w.quota ? (
        <p className="rounded-md border border-status-warning/60 bg-status-warning/10 p-2">
          {ctx.blockWhenQuotaExhausted ? t("quotaBlock") : t("quotaWarning")}
        </p>
      ) : null}
      {w.jobCap ? (
        <p className="rounded-md border border-status-warning/60 bg-status-warning/10 p-2">
          {t("jobCapWarning", { cap: ctx.maxJobMinutes })}
        </p>
      ) : null}
    </div>
  );
}

export function QueueForm({
  ctx,
  definition,
  controls,
}: {
  ctx: AzureActionContext;
  definition: {
    projectId: string;
    id: number;
    name: string;
    defaultBranch: string | null;
    p90Minutes: number | null;
  };
  controls: DialogControls;
}) {
  const t = useTranslations("ci.azure.actions");
  const [key] = useState(() => crypto.randomUUID());
  const [branch, setBranch] = useState(definition.defaultBranch ?? "");
  const [result, setResult] = useState<AzureResultLike>();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const done = result?.status === "succeeded";
  const blocked =
    ctx.blockWhenQuotaExhausted &&
    runWarning({
      minutesLeft: ctx.minutesLeft,
      p90Minutes: definition.p90Minutes,
      maxJobMinutes: ctx.maxJobMinutes,
    }).quota;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await queueAzureRunAction({
              installationId: ctx.installationId,
              projectId: definition.projectId,
              definitionId: definition.id,
              branch: branch.trim() || null,
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
      <p className="text-sm">
        {t("confirm.queue", { pipeline: definition.name })}
      </p>
      <label htmlFor={id} className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("branch")}</span>
        <input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={255}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 font-mono text-sm"
        />
      </label>
      <QuotaNote ctx={ctx} p90Minutes={definition.p90Minutes} />
      <p className="text-xs text-muted-foreground">{t("noParameters")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={pending || done || blocked || !branch.trim()}
        >
          {pending ? t("pending") : t("op.queue")}
        </Button>
        <AzureResult result={result} />
      </div>
    </form>
  );
}

export function QueueRunButton(props: {
  ctx: AzureActionContext;
  definition: {
    projectId: string;
    id: number;
    name: string;
    defaultBranch: string | null;
    p90Minutes: number | null;
  };
  compact?: boolean;
}) {
  const t = useTranslations("ci.azure.actions");
  return (
    <ActionDialog
      trigger={t("op.queue")}
      triggerLabel={t("opFor", {
        op: t("op.queue"),
        target: props.definition.name,
      })}
      triggerSize={props.compact ? "xs" : "sm"}
      title={t("title.queue", { pipeline: props.definition.name })}
    >
      {(controls) => <QueueForm {...props} controls={controls} />}
    </ActionDialog>
  );
}

type BuildRef = {
  id: number;
  buildNumber: string;
  definitionName: string;
  status: string;
  result: string;
  p90Minutes?: number | null;
};

export function BuildForm({
  ctx,
  build,
  operation,
  stage,
  controls,
}: {
  ctx: AzureActionContext;
  build: BuildRef;
  operation: "cancel" | "retry" | "retryStage";
  stage?: { identifier: string; name: string };
  controls: DialogControls;
}) {
  const t = useTranslations("ci.azure.actions");
  const [key] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState<AzureResultLike>();
  const [pending, startTransition] = useTransition();
  const done = result?.status === "succeeded";
  const blocked =
    operation === "retry" &&
    ctx.blockWhenQuotaExhausted &&
    runWarning({
      minutesLeft: ctx.minutesLeft,
      p90Minutes: build.p90Minutes ?? null,
      maxJobMinutes: ctx.maxJobMinutes,
    }).quota;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await azureBuildAction({
              installationId: ctx.installationId,
              buildId: build.id,
              operation,
              stage: stage?.identifier ?? null,
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
      <p className="text-sm">
        {t(`confirm.${operation}`, {
          build: `#${build.buildNumber}`,
          pipeline: build.definitionName,
          stage: stage?.name ?? "",
        })}
      </p>
      {operation === "cancel" ? (
        <p className="text-sm text-muted-foreground">{t("cancelNote")}</p>
      ) : null}
      {operation !== "cancel" ? (
        <QuotaNote ctx={ctx} p90Minutes={build.p90Minutes ?? null} />
      ) : null}
      <p className="text-xs text-muted-foreground">{t("actingAsNote")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant={operation === "cancel" ? "destructive" : "default"}
          disabled={pending || done || blocked}
        >
          {pending ? t("pending") : t(`op.${operation}`)}
        </Button>
        <AzureResult result={result} />
      </div>
    </form>
  );
}

/** Cancel and retry of one build (operators, every gate open). */
export function BuildActions({
  ctx,
  build,
  compact = false,
}: {
  ctx: AzureActionContext;
  build: BuildRef;
  compact?: boolean;
}) {
  const t = useTranslations("ci.azure.actions");
  const ops = azureOperations(build);
  if (ops.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ops.map((op) => (
        <ActionDialog
          key={op}
          trigger={t(`op.${op}`)}
          triggerLabel={t("opFor", {
            op: t(`op.${op}`),
            target: `#${build.buildNumber}`,
          })}
          triggerSize={compact ? "xs" : "sm"}
          triggerVariant={op === "cancel" ? "destructive" : "outline"}
          title={t(`title.${op}`, { build: `#${build.buildNumber}` })}
        >
          {(controls) => (
            <BuildForm
              ctx={ctx}
              build={build}
              operation={op}
              controls={controls}
            />
          )}
        </ActionDialog>
      ))}
    </div>
  );
}

export function StageRetryButton({
  ctx,
  build,
  stage,
}: {
  ctx: AzureActionContext;
  build: BuildRef;
  stage: { identifier: string; name: string };
}) {
  const t = useTranslations("ci.azure.actions");
  return (
    <ActionDialog
      trigger={t("op.retryStage")}
      triggerLabel={t("opFor", { op: t("op.retryStage"), target: stage.name })}
      triggerSize="xs"
      title={t("title.retryStage", { stage: stage.name })}
    >
      {(controls) => (
        <BuildForm
          ctx={ctx}
          build={build}
          operation="retryStage"
          stage={stage}
          controls={controls}
        />
      )}
    </ActionDialog>
  );
}

type LogLine = {
  at: string | null;
  stream: "out" | "err" | "cmd";
  text: string;
};

/** "Show log": the newest 200 lines of one job, read live, never stored. */
export function AzureLogExcerpt({
  installationId,
  buildId,
  recordId,
  attempt,
}: {
  installationId: string;
  buildId: number;
  recordId: string;
  attempt: number;
}) {
  const t = useTranslations("ci.azure.log");
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
                const res = await azureLogAction({
                  installationId,
                  buildId,
                  recordId,
                  attempt,
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
                          [
                            "forbidden",
                            "unauthorized",
                            "unavailable",
                            "rate_limited",
                            "not_found",
                          ].includes(res.status)
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

export function ToggleForm({
  installationId,
  orgName,
  enabled,
  controls,
}: {
  installationId: string;
  orgName: string;
  enabled: boolean;
  controls: DialogControls;
}) {
  const t = useTranslations("ci.azure.settings.management");
  const tm = useTranslations("management");
  const [key] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<AzureResultLike>();
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
            const res = await setAzureManagementAction({
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
        <span>{tm("typeToConfirm", { text: orgName })}</span>
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
          disabled={pending || done || typed.trim() !== orgName}
        >
          {enabled ? t("disable") : t("enable")}
        </Button>
        <AzureResult result={result} />
      </div>
    </form>
  );
}

/** The Azure Pipelines management toggle (admin, typed organisation name, execute probe). */
export function AzureManagementToggle(props: {
  installationId: string;
  orgName: string;
  enabled: boolean;
}) {
  const t = useTranslations("ci.azure.settings.management");
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
