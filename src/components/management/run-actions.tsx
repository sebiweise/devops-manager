"use client";

import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  runOperationsFor,
  type ResultLike,
  type RunOperation,
} from "@/lib/management-view";
import { runOperationAction } from "@/server/actions/runs";
import {
  ActionDialog,
  ResultMessage,
  type DialogControls,
} from "./action-dialog";

/**
 * Run actions (design §8.2 #1 to #4): re-run, re-run failed jobs, cancel
 * and force cancel, each behind a dialog that names the repo, workflow, run
 * number and attempt. Pages render this only for operators and admins while
 * management is on; the server enforces the same rule.
 */

export type RunActionTarget = {
  id: string;
  repoFullName: string;
  workflowName: string;
  runNumber: number | null;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  isPlaceholder?: boolean;
};

export function RunActions({
  installationId,
  run,
  forceCancelAvailable = false,
  compact = false,
}: {
  installationId: string;
  run: RunActionTarget;
  forceCancelAvailable?: boolean;
  /** Smaller buttons with run-specific accessible names (run lists). */
  compact?: boolean;
}) {
  const t = useTranslations("management.runs");
  const ops = runOperationsFor(run, forceCancelAvailable);
  if (ops.length === 0) return null;
  const runLabel = run.runNumber != null ? `#${run.runNumber}` : run.id;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ops.map((op) => (
        <ActionDialog
          key={op}
          trigger={t(`op.${op}`)}
          triggerLabel={
            compact
              ? t("opFor", { op: t(`op.${op}`), run: runLabel })
              : undefined
          }
          triggerSize={compact ? "xs" : "sm"}
          triggerVariant={
            op === "cancel" || op === "force_cancel" ? "destructive" : "outline"
          }
          title={t(`title.${op}`)}
        >
          {(controls) => (
            <RunActionPanel
              installationId={installationId}
              run={run}
              operation={op}
              controls={controls}
            />
          )}
        </ActionDialog>
      ))}
    </div>
  );
}

export function RunActionPanel({
  installationId,
  run,
  operation,
  controls,
}: {
  installationId: string;
  run: RunActionTarget;
  operation: RunOperation;
  controls: DialogControls;
}) {
  const t = useTranslations("management.runs");
  const tm = useTranslations("management");
  const id = useId();
  const [key] = useState(() => crypto.randomUUID());
  const [debug, setDebug] = useState(false);
  const [result, setResult] = useState<ResultLike>();
  const [pending, startTransition] = useTransition();
  const done = result?.status === "succeeded";
  const rerun = operation === "rerun" || operation === "rerun_failed";

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await runOperationAction({
              installationId,
              runId: run.id,
              operation,
              ...(rerun ? { enableDebugLogging: debug } : {}),
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
      <p className="text-sm">{t(`confirm.${operation}`)}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("repo")}</dt>
        <dd>{run.repoFullName}</dd>
        <dt className="text-muted-foreground">{t("workflow")}</dt>
        <dd>{run.workflowName}</dd>
        <dt className="text-muted-foreground">{t("run")}</dt>
        <dd>{run.runNumber != null ? `#${run.runNumber}` : run.id}</dd>
        <dt className="text-muted-foreground">{t("attempt")}</dt>
        <dd>{run.runAttempt}</dd>
      </dl>
      {rerun ? (
        <div className="flex items-center gap-2 text-sm">
          <input
            id={`${id}-debug`}
            type="checkbox"
            checked={debug}
            onChange={(e) => setDebug(e.target.checked)}
          />
          <label htmlFor={`${id}-debug`}>{t("debugLogging")}</label>
        </div>
      ) : null}
      {operation === "force_cancel" ? (
        <p className="text-sm text-destructive">{t("forceCancelWarning")}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{tm("actingAsNote")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant={rerun ? "default" : "destructive"}
          disabled={pending || done}
        >
          {pending ? t("pending") : t(`op.${operation}`)}
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}
