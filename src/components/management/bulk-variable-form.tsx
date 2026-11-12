"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ResultLike } from "@/lib/management-view";
import {
  bulkSetVariableAction,
  previewBulkSetAction,
} from "@/server/actions/variables";
import type { BulkResult, BulkRowResult } from "@/server/management/variables";
import type {
  BulkRow,
  RevertRow,
  VariablePreset,
} from "@/server/management/variable-rules";
import { ResultMessage } from "./action-dialog";
import { isVariableName, TypedConfirmation } from "./variable-editors";

/**
 * Bulk set of a repository variable (design §8.2 #6), admin only: pick a
 * runs-on preset (`LINUX_RUNNER`, `MACOS_RUNNER` from VARIABLE_PRESETS) or
 * any name, a value and the target repos, review the preview diff (repo:
 * current → new; unchanged, archived and deselected repos marked), type the
 * variable name and apply. The result lists every repo; one parent and one
 * child audit row per write are recorded on the server.
 */

export type BulkRepo = {
  repositoryId: string;
  fullName: string;
  archived: boolean;
};

const CUSTOM = "__custom__";

export function BulkVariableForm({
  installationId,
  presets,
  repos,
}: {
  installationId: string;
  presets: VariablePreset[];
  repos: BulkRepo[];
}) {
  const t = useTranslations("management.bulk");
  const tv = useTranslations("management.variables");
  const router = useRouter();
  const id = useId();
  const repoPresets = presets.filter((p) => p.scope === "repository");
  const first = repoPresets[0];
  const [preset, setPreset] = useState(first?.name ?? CUSTOM);
  const [customName, setCustomName] = useState("");
  const [value, setValue] = useState(first?.values[0] ?? "");
  const [selected, setSelected] = useState<string[]>(
    repos.filter((r) => !r.archived).map((r) => r.repositoryId),
  );
  const [preview, setPreview] = useState<{
    key: string;
    name: string;
    value: string;
    repositoryIds: string[];
    rows: BulkRow[];
  }>();
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<ResultLike>();
  const [applied, setApplied] = useState<BulkResult>();
  const [pending, startTransition] = useTransition();

  const active = repoPresets.find((p) => p.name === preset);
  const name = active ? active.name : customName;
  const reset = () => {
    setPreview(undefined);
    setTyped("");
    setResult(undefined);
    setApplied(undefined);
  };

  const runPreview = () =>
    startTransition(async () => {
      try {
        const res = await previewBulkSetAction({
          installationId,
          name,
          value,
          repositoryIds: selected,
        });
        if (res.status === "ok") {
          setResult(undefined);
          setPreview({
            key: crypto.randomUUID(),
            name: res.name,
            value: res.value,
            repositoryIds: selected,
            rows: res.rows,
          });
        } else {
          setPreview(undefined);
          setResult(res);
        }
      } catch {
        setResult({ status: "error" });
      }
    });

  const apply = () =>
    startTransition(async () => {
      if (!preview) return;
      try {
        const res = await bulkSetVariableAction({
          installationId,
          name: preview.name,
          value: preview.value,
          repositoryIds: preview.repositoryIds,
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

  const writes = preview?.rows.filter(
    (r) => r.change === "create" || r.change === "update",
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          runPreview();
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{t("variable")}</legend>
          {repoPresets.map((p) => (
            <div key={p.name} className="flex items-center gap-2 text-sm">
              <input
                id={`${id}-preset-${p.name}`}
                type="radio"
                name={`${id}-preset`}
                checked={preset === p.name}
                onChange={() => {
                  setPreset(p.name);
                  setValue(p.values[0] ?? "");
                  reset();
                }}
              />
              <label htmlFor={`${id}-preset-${p.name}`} className="font-mono">
                {p.name}
              </label>
            </div>
          ))}
          <div className="flex items-center gap-2 text-sm">
            <input
              id={`${id}-preset-custom`}
              type="radio"
              name={`${id}-preset`}
              checked={preset === CUSTOM}
              onChange={() => {
                setPreset(CUSTOM);
                reset();
              }}
            />
            <label htmlFor={`${id}-preset-custom`}>{t("customName")}</label>
          </div>
          {preset === CUSTOM ? (
            <div className="mt-1 flex flex-col gap-1">
              <label htmlFor={`${id}-name`} className="text-sm font-medium">
                {tv("name")}
              </label>
              <input
                id={`${id}-name`}
                value={customName}
                onChange={(e) => {
                  setCustomName(e.target.value);
                  reset();
                }}
                autoComplete="off"
                spellCheck={false}
                maxLength={255}
                aria-invalid={
                  customName.length > 0 && !isVariableName(customName)
                }
                className="h-9 max-w-sm rounded-md border bg-background px-3 font-mono text-sm"
              />
            </div>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{tv("value")}</legend>
          {active
            ? active.values.map((v) => (
                <div key={v} className="flex items-center gap-2 text-sm">
                  <input
                    id={`${id}-value-${v}`}
                    type="radio"
                    name={`${id}-value`}
                    checked={value === v}
                    onChange={() => {
                      setValue(v);
                      reset();
                    }}
                  />
                  <label htmlFor={`${id}-value-${v}`} className="font-mono">
                    {v}
                  </label>
                </div>
              ))
            : null}
          {!active ? (
            <>
              <label htmlFor={`${id}-value`} className="sr-only">
                {tv("value")}
              </label>
              <input
                id={`${id}-value`}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  reset();
                }}
                autoComplete="off"
                spellCheck={false}
                maxLength={49_152}
                className="h-9 max-w-sm rounded-md border bg-background px-3 font-mono text-sm"
              />
            </>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">
            {t("repositories", { count: selected.length })}
          </legend>
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setSelected(
                  repos.filter((r) => !r.archived).map((r) => r.repositoryId),
                );
                reset();
              }}
            >
              {t("selectAll")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setSelected([]);
                reset();
              }}
            >
              {t("selectNone")}
            </Button>
          </div>
          <div className="grid max-h-72 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
            {repos.map((r) => (
              <div
                key={r.repositoryId}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  id={`${id}-repo-${r.repositoryId}`}
                  type="checkbox"
                  checked={selected.includes(r.repositoryId)}
                  onChange={(e) => {
                    setSelected((s) =>
                      e.target.checked
                        ? [...s, r.repositoryId]
                        : s.filter((x) => x !== r.repositoryId),
                    );
                    reset();
                  }}
                />
                <label htmlFor={`${id}-repo-${r.repositoryId}`}>
                  {r.fullName}
                  {r.archived ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({tv("archived")})
                    </span>
                  ) : null}
                </label>
              </div>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={
              pending ||
              !isVariableName(name) ||
              value.length === 0 ||
              selected.length === 0
            }
          >
            {pending && !preview ? t("previewing") : t("preview")}
          </Button>
          {!preview ? <ResultMessage result={result} /> : null}
        </div>
      </form>

      {preview ? (
        <section className="flex flex-col gap-3" aria-labelledby={`${id}-diff`}>
          <h2 id={`${id}-diff`} className="font-medium">
            {t("previewTitle", { name: preview.name, value: preview.value })}
          </h2>
          <ChangeTable
            caption={t("previewTitle", {
              name: preview.name,
              value: preview.value,
            })}
            rows={preview.rows.map((r) => ({
              repositoryId: r.repositoryId,
              fullName: r.fullName,
              from: r.current,
              to: r.next,
              change: r.change,
              reason: r.reason,
            }))}
          />
          {applied ? null : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              <p className="text-sm">
                {t("applySummary", { count: writes ?? 0 })}
              </p>
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
                  disabled={
                    pending || typed.trim() !== preview.name || writes === 0
                  }
                >
                  {pending ? t("applying") : t("apply")}
                </Button>
                <ResultMessage result={result} />
              </div>
            </form>
          )}
        </section>
      ) : null}

      {applied ? <BulkResultView result={applied} outcome={result} /> : null}
    </div>
  );
}

/** A skip or failure reason in words; unknown codes are shown as they are. */
function reasonText(
  t: ReturnType<typeof useTranslations<"management">>,
  reason: string,
): string {
  return t.has(`refused.${reason}`)
    ? t(`refused.${reason}`, { seconds: 0, state: "" })
    : reason;
}

type ChangeRow = {
  repositoryId: string;
  fullName: string;
  from: string | null;
  to: string | null;
  change: BulkRow["change"] | RevertRow["change"];
  reason?: string;
};

/** The preview diff: repo, current → new, the change and why a repo is skipped. */
export function ChangeTable({
  rows,
  caption,
}: {
  rows: ChangeRow[];
  caption: string;
}) {
  const t = useTranslations("management");
  const tv = useTranslations("management.variables");
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{tv("repository")}</TableHead>
          <TableHead scope="col">{tv("before")}</TableHead>
          <TableHead scope="col">{tv("after")}</TableHead>
          <TableHead scope="col">{t("bulk.change")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.repositoryId}>
            <TableCell className="font-medium">{r.fullName}</TableCell>
            <TableCell className="font-mono text-xs">
              {r.from ?? (
                <span className="font-sans italic">{tv("notSet")}</span>
              )}
            </TableCell>
            <TableCell className="font-mono text-xs">
              {r.to ?? (
                <span className="font-sans italic">{tv("deleted")}</span>
              )}
            </TableCell>
            <TableCell className="text-xs">
              {t(`bulk.${r.change}`)}
              {r.reason ? (
                <span className="block text-muted-foreground">
                  {reasonText(t, r.reason)}
                </span>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Per-repo results of a bulk set or a revert. */
export function BulkResultView({
  result,
  outcome,
}: {
  result: BulkResult;
  outcome?: ResultLike;
}) {
  const t = useTranslations("management");
  const tv = useTranslations("management.variables");
  return (
    <section className="flex flex-col gap-2" aria-label={t("bulk.results")}>
      <h2 className="font-medium">{t("bulk.results")}</h2>
      <p role="status" aria-live="polite" className="text-sm">
        {t("bulk.summary", {
          succeeded: result.succeeded,
          failed: result.failed,
        })}
      </p>
      {outcome?.status === "failed" ? <ResultMessage result={outcome} /> : null}
      <Table>
        <caption className="sr-only">{t("bulk.results")}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{tv("repository")}</TableHead>
            <TableHead scope="col">{t("bulk.change")}</TableHead>
            <TableHead scope="col">{t("bulk.status")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.map((r: BulkRowResult) => (
            <TableRow key={`${r.repositoryId}-${r.auditId ?? r.status}`}>
              <TableCell className="font-medium">{r.fullName}</TableCell>
              <TableCell className="text-xs">{t(`bulk.${r.change}`)}</TableCell>
              <TableCell className="text-xs">
                <span
                  className={r.status === "failed" ? "text-destructive" : ""}
                >
                  {t(`bulk.rowStatus.${r.status}`)}
                </span>
                {r.message ? (
                  <span className="block text-muted-foreground">
                    {r.message}
                  </span>
                ) : r.reason && r.reason !== "unchanged" ? (
                  <span className="block text-muted-foreground">
                    {reasonText(t, r.reason)}
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
