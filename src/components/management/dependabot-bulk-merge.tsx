"use client";

import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { shortSha } from "@/lib/format";
import {
  bulkMergeCandidates,
  type MergeMethod,
  type ResultLike,
} from "@/lib/management-view";
import { bulkMergeDependabotAction } from "@/server/actions/pulls";
import type { PullRow } from "@/server/data/pulls";
import type { BulkMergeResult } from "@/server/management/pulls";
import {
  ActionDialog,
  ResultMessage,
  type DialogControls,
} from "./action-dialog";
import { TypedConfirmation } from "./variable-editors";

/**
 * Guarded Dependabot bulk merge (design §8.2 #10), admin only: the dialog
 * lists every PR it will merge (Dependabot patch and minor updates that are
 * mergeable, CLEAN and green), needs the number of PRs typed, and shows the
 * result of each one. The server re-checks every PR right before its merge,
 * merges them one after another and stops at the first unexpected error.
 */

type Candidate = ReturnType<typeof bulkMergeCandidates<PullRow>>[number];

export function DependabotBulkMerge({
  installationId,
  pulls,
  mergeMethods,
  workflowsGranted,
}: {
  installationId: string;
  pulls: PullRow[];
  mergeMethods: Record<string, MergeMethod[]>;
  workflowsGranted: boolean;
}) {
  const t = useTranslations("management.pulls.bulkMerge");
  const candidates = bulkMergeCandidates(pulls, {
    workflowsGranted,
    mergeMethods,
  });
  if (candidates.length === 0) return null;
  return (
    <ActionDialog
      trigger={t("open", { count: candidates.length })}
      title={t("title")}
    >
      {(controls) => (
        <BulkMergePanel
          installationId={installationId}
          candidates={candidates}
          controls={controls}
        />
      )}
    </ActionDialog>
  );
}

export function BulkMergePanel({
  installationId,
  candidates,
  controls,
}: {
  installationId: string;
  candidates: Candidate[];
  controls: DialogControls;
}) {
  const t = useTranslations("management.pulls.bulkMerge");
  const id = useId();
  const [key] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<ResultLike>();
  const [done, setDone] = useState<BulkMergeResult>();
  const [pending, startTransition] = useTransition();
  const expected = String(candidates.length);

  if (done) return <BulkMergeResultView result={done} outcome={result} />;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await bulkMergeDependabotAction({
              installationId,
              items: candidates.map((c) => ({
                repositoryId: c.repositoryId,
                number: c.number,
                sha: c.headSha,
              })),
              typed,
              idempotencyKey: key,
            });
            setResult(res);
            if (
              (res.status === "succeeded" || res.status === "failed") &&
              res.data
            ) {
              setDone(res.data);
              controls.changed();
            }
          } catch {
            setResult({ status: "error" });
          }
        });
      }}
    >
      <p className="text-sm">{t("intro")}</p>
      <Table>
        <caption className="sr-only">{t("listCaption")}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t("pull")}</TableHead>
            <TableHead scope="col">{t("update")}</TableHead>
            <TableHead scope="col">{t("headSha")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {candidates.map((c) => (
            <TableRow key={`${c.repositoryId}-${c.number}`}>
              <TableCell className="text-sm">
                <span className="block font-medium">{c.repoFullName}</span>#
                {c.number} {c.title}
              </TableCell>
              <TableCell className="text-xs">
                {t(`updateType.${c.updateType}`)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {shortSha(c.headSha)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">{t("guards")}</p>
      <TypedConfirmation
        id={`${id}-typed`}
        expected={expected}
        value={typed}
        onChange={setTyped}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          disabled={pending || typed.trim() !== expected}
        >
          {pending ? t("merging") : t("merge", { count: candidates.length })}
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}

const REASONS = new Set([
  "not_dependabot",
  "already_merged",
  "not_open",
  "draft",
  "head_moved",
  "not_mergeable",
  "branch_protection",
  "not_clean",
  "checks_not_green",
  "not_patch_or_minor",
  "workflows_not_granted",
  "no_method",
  "archived",
  "not_selected",
  "pr_not_found",
  "unreadable",
]);

export function BulkMergeResultView({
  result,
  outcome,
}: {
  result: BulkMergeResult;
  outcome?: ResultLike;
}) {
  const t = useTranslations("management.pulls.bulkMerge");
  return (
    <section className="flex flex-col gap-2" aria-label={t("results")}>
      <p role="status" aria-live="polite" className="text-sm">
        {t("summary", {
          merged: result.merged,
          skipped: result.skipped,
          failed: result.failed,
          notAttempted: result.notAttempted,
        })}
      </p>
      {outcome?.status === "failed" ? <ResultMessage result={outcome} /> : null}
      <Table>
        <caption className="sr-only">{t("results")}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t("pull")}</TableHead>
            <TableHead scope="col">{t("status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.map((r) => (
            <TableRow key={`${r.repositoryId}-${r.number}`}>
              <TableCell className="text-sm">
                {r.fullName ?? r.repositoryId} #{r.number}
              </TableCell>
              <TableCell className="text-xs">
                <span
                  className={r.status === "failed" ? "text-destructive" : ""}
                >
                  {t(`rowStatus.${r.status}`)}
                </span>
                {r.message ? (
                  <span className="block text-muted-foreground">
                    {r.message}
                  </span>
                ) : r.reason ? (
                  <span className="block text-muted-foreground">
                    {REASONS.has(r.reason) ? t(`reason.${r.reason}`) : r.reason}
                  </span>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
