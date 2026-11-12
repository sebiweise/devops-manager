"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ResultLike } from "@/lib/management-view";
import {
  previewRevertAction,
  revertBatchAction,
} from "@/server/actions/variables";
import type { BulkResult } from "@/server/management/variables";
import type { RevertRow } from "@/server/management/variable-rules";
import { ResultMessage } from "./action-dialog";
import { BulkResultView, ChangeTable } from "./bulk-variable-form";
import { TypedConfirmation } from "./variable-editors";

/**
 * Revert batch (design §8.2 #7), admin only: previews which repos get their
 * recorded `before` value back (created variables are deleted, values that
 * changed after the batch are left alone), then applies it after the
 * variable name is typed. A batch is reverted at most once.
 */
export function RevertBatchForm({
  installationId,
  batchId,
}: {
  installationId: string;
  batchId: string;
}) {
  const t = useTranslations("management.revert");
  const router = useRouter();
  const id = useId();
  const [preview, setPreview] = useState<{
    key: string;
    name: string;
    rows: RevertRow[];
    revertedBy: string | null;
  }>();
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<ResultLike>();
  const [applied, setApplied] = useState<BulkResult>();
  const [pending, startTransition] = useTransition();

  const load = () =>
    startTransition(async () => {
      try {
        const res = await previewRevertAction({ installationId, batchId });
        if (res.status === "ok") {
          setResult(undefined);
          setPreview({
            key: crypto.randomUUID(),
            name: res.name,
            rows: res.rows,
            revertedBy: res.revertedBy,
          });
        } else setResult(res);
      } catch {
        setResult({ status: "error" });
      }
    });

  const apply = () =>
    startTransition(async () => {
      if (!preview) return;
      try {
        const res = await revertBatchAction({
          installationId,
          batchId,
          typed,
          idempotencyKey: preview.key,
        });
        setResult(res);
        if (
          (res.status === "succeeded" || res.status === "failed") &&
          res.data
        ) {
          setApplied(res.data);
          router.refresh();
        }
      } catch {
        setResult({ status: "error" });
      }
    });

  const changes = preview?.rows.filter(
    (r) => r.change === "restore" || r.change === "delete",
  ).length;

  return (
    <div className="flex flex-col gap-4">
      {!preview ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={load}
          >
            {pending ? t("loading") : t("preview")}
          </Button>
          <ResultMessage result={result} />
        </div>
      ) : (
        <>
          <ChangeTable
            caption={t("previewTitle", { name: preview.name })}
            rows={preview.rows.map((r) => ({
              repositoryId: r.repositoryId,
              fullName: r.fullName,
              from: r.current,
              to: r.target,
              change: r.change,
              reason: r.reason,
            }))}
          />
          {preview.revertedBy ? (
            <p className="text-sm text-muted-foreground">
              {t("alreadyReverted")}
            </p>
          ) : applied ? null : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              <p className="text-sm">{t("summary", { count: changes ?? 0 })}</p>
              <TypedConfirmation
                id={`${id}-typed`}
                expected={preview.name}
                value={typed}
                onChange={setTyped}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  size="sm"
                  variant="destructive"
                  disabled={
                    pending || typed.trim() !== preview.name || changes === 0
                  }
                >
                  {pending ? t("applying") : t("apply")}
                </Button>
                <ResultMessage result={result} />
              </div>
            </form>
          )}
        </>
      )}
      {applied ? <BulkResultView result={applied} outcome={result} /> : null}
    </div>
  );
}
