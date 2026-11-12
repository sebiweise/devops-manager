"use client";

import { useFormatter, useNow, useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { shortSha } from "@/lib/format";
import {
  checksKey,
  defaultMergeMethod,
  mergeBlock,
  needsAcknowledgement,
  type MergeMethod,
  type ResultLike,
} from "@/lib/management-view";
import { mergePullRequestAction } from "@/server/actions/pulls";
import type { PullRow } from "@/server/data/pulls";
import {
  ActionDialog,
  ResultMessage,
  type DialogControls,
} from "./action-dialog";

/**
 * Open pull requests (design §7 /pulls): checks rollup, mergeable state,
 * review decision, age and the Dependabot, draft, failing and "changes
 * workflows" chips. Admins get a merge dialog while management is on: the
 * merge is pinned to the head SHA shown, uses one of the methods the repo
 * allows, notes workflow changes and needs an extra confirmation when
 * GitHub's merge state is not CLEAN. GitHub's 405/409 answers are shown
 * verbatim.
 */

export function PullChips({ pull }: { pull: PullRow }) {
  const t = useTranslations("management.pulls");
  const failing = checksKey(pull.checks) === "failure";
  return (
    <span className="flex flex-wrap gap-1">
      {pull.isDependabot ? (
        <Badge variant="secondary">{t("chip.dependabot")}</Badge>
      ) : null}
      {pull.isDraft ? <Badge variant="outline">{t("chip.draft")}</Badge> : null}
      {failing ? (
        <Badge variant="destructive">{t("chip.failing")}</Badge>
      ) : null}
      {pull.changesWorkflows !== false ? (
        <Badge variant="outline">
          {pull.changesWorkflows ? t("chip.workflows") : t("chip.manyFiles")}
        </Badge>
      ) : null}
    </span>
  );
}

export function MergePanel({
  installationId,
  pull,
  methods,
  mergeAuditTrailer,
  controls,
}: {
  installationId: string;
  pull: PullRow;
  methods: MergeMethod[];
  mergeAuditTrailer: boolean;
  controls: DialogControls;
}) {
  const t = useTranslations("management.pulls");
  const tm = useTranslations("management");
  const id = useId();
  const [key] = useState(() => crypto.randomUUID());
  const [method, setMethod] = useState<MergeMethod>(
    defaultMergeMethod(methods) ?? "merge",
  );
  const ackNeeded = needsAcknowledgement(pull.mergeStateStatus);
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<ResultLike>();
  const [pending, startTransition] = useTransition();
  const done = result?.status === "succeeded";

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await mergePullRequestAction({
              installationId,
              repositoryId: pull.repositoryId,
              number: pull.number,
              sha: pull.headSha,
              method,
              ...(ackNeeded ? { acknowledgeNotClean: ack } : {}),
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
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("pull")}</dt>
        <dd>
          {pull.repoFullName} #{pull.number}: {pull.title}
        </dd>
        <dt className="text-muted-foreground">{t("branches")}</dt>
        <dd className="font-mono text-xs">
          {pull.headRef} → {pull.baseRef}
        </dd>
        <dt className="text-muted-foreground">{t("headSha")}</dt>
        <dd className="font-mono text-xs">{shortSha(pull.headSha)}</dd>
        <dt className="text-muted-foreground">{t("checks")}</dt>
        <dd>{t(`checksState.${checksKey(pull.checks)}`)}</dd>
        <dt className="text-muted-foreground">{t("mergeState")}</dt>
        <dd>{pull.mergeStateStatus ?? "UNKNOWN"}</dd>
      </dl>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t("method")}</legend>
        {methods.map((m) => (
          <div key={m} className="flex items-center gap-2 text-sm">
            <input
              id={`${id}-m-${m}`}
              type="radio"
              name={`${id}-method`}
              checked={method === m}
              onChange={() => setMethod(m)}
            />
            <label htmlFor={`${id}-m-${m}`}>{t(`methods.${m}`)}</label>
          </div>
        ))}
      </fieldset>
      {pull.changesWorkflows !== false ? (
        <p className="text-sm">
          {pull.changesWorkflows ? t("workflowsNote") : t("manyFilesNote")}
        </p>
      ) : null}
      {ackNeeded ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 p-2 text-sm">
          <input
            id={`${id}-ack`}
            type="checkbox"
            className="mt-1"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          <label htmlFor={`${id}-ack`}>
            {t("acknowledge", { state: pull.mergeStateStatus ?? "UNKNOWN" })}
          </label>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {tm("actingAsNote")}
        {mergeAuditTrailer ? ` ${t("trailerNote")}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={pending || done || (ackNeeded && !ack)}
        >
          {pending ? t("merging") : t("merge")}
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}

export function PullsTable({
  installationId,
  pulls,
  mergeMethods,
  workflowsGranted,
  canMerge,
  mergeAuditTrailer,
  showRepo = true,
  caption,
}: {
  installationId: string;
  pulls: PullRow[];
  /** Allowed merge methods per repository id. */
  mergeMethods: Record<string, MergeMethod[]>;
  workflowsGranted: boolean;
  canMerge: boolean;
  mergeAuditTrailer: boolean;
  showRepo?: boolean;
  caption: string;
}) {
  const t = useTranslations("management.pulls");
  const format = useFormatter();
  const now = useNow();
  if (pulls.length === 0)
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          {showRepo ? <TableHead scope="col">{t("repo")}</TableHead> : null}
          <TableHead scope="col">{t("pull")}</TableHead>
          <TableHead scope="col">{t("checks")}</TableHead>
          <TableHead scope="col">{t("mergeable")}</TableHead>
          <TableHead scope="col">{t("review")}</TableHead>
          <TableHead scope="col">{t("age")}</TableHead>
          {canMerge ? <TableHead scope="col">{t("actions")}</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {pulls.map((p) => {
          const methods = mergeMethods[p.repositoryId] ?? [];
          const block = mergeBlock(p, { workflowsGranted, methods });
          return (
            <TableRow key={`${p.repositoryId}-${p.number}`}>
              {showRepo ? (
                <TableCell className="font-medium">{p.repoFullName}</TableCell>
              ) : null}
              <TableCell className="max-w-96">
                <a
                  href={p.url}
                  rel="noopener noreferrer"
                  target="_blank"
                  className="underline-offset-2 hover:underline"
                >
                  #{p.number} {p.title}
                </a>
                <span className="block text-xs text-muted-foreground">
                  {p.author ?? "—"} · {p.headRef} → {p.baseRef}
                </span>
                <PullChips pull={p} />
              </TableCell>
              <TableCell className="text-xs">
                {t(`checksState.${checksKey(p.checks)}`)}
              </TableCell>
              <TableCell className="text-xs">
                {t(`mergeableState.${p.mergeable}`)}
                {p.mergeStateStatus ? (
                  <span className="block text-muted-foreground">
                    {p.mergeStateStatus}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-xs">
                {p.reviewDecision
                  ? t.has(`reviewState.${p.reviewDecision}`)
                    ? t(`reviewState.${p.reviewDecision}`)
                    : p.reviewDecision
                  : "—"}
              </TableCell>
              <TableCell className="text-xs whitespace-nowrap">
                <time dateTime={p.createdAt}>
                  {format.relativeTime(new Date(p.createdAt), now)}
                </time>
              </TableCell>
              {canMerge ? (
                <TableCell>
                  {block ? (
                    <span className="text-xs text-muted-foreground">
                      {t(`blocked.${block}`)}
                    </span>
                  ) : (
                    <ActionDialog
                      trigger={t("merge")}
                      triggerLabel={t("mergeFor", {
                        number: p.number,
                        repo: p.repoFullName,
                      })}
                      triggerSize="xs"
                      title={t("mergeTitle", {
                        number: p.number,
                        repo: p.repoFullName,
                      })}
                    >
                      {(controls) => (
                        <MergePanel
                          installationId={installationId}
                          pull={p}
                          methods={methods}
                          mergeAuditTrailer={mergeAuditTrailer}
                          controls={controls}
                        />
                      )}
                    </ActionDialog>
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
