"use client";

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
  deleteOrgVariableAction,
  setOrgVariableAction,
} from "@/server/actions/variables";
import type { OrgVariableRow } from "@/server/data/variables";
import {
  ActionDialog,
  ResultMessage,
  type DialogControls,
} from "./action-dialog";
import {
  CellValue,
  isVariableName,
  TypedConfirmation,
  type RepoChoice,
} from "./variable-editors";

/**
 * Organisation variables (design §8.2 #8), org installations with
 * Organization `Variables` granted: name, value and visibility (all,
 * private, selected repositories). Admins create, update and delete with
 * the variable name typed as confirmation.
 */

type Visibility = "all" | "private" | "selected";
const VISIBILITIES: Visibility[] = ["all", "private", "selected"];

export function OrgVariablePanel({
  installationId,
  repos,
  variable,
  controls,
}: {
  installationId: string;
  repos: RepoChoice[];
  /** The variable to edit; undefined creates a new one. */
  variable?: OrgVariableRow;
  controls: DialogControls;
}) {
  const t = useTranslations("management.variables");
  const tm = useTranslations("management");
  const id = useId();
  const [key] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(variable?.name ?? "");
  const [value, setValue] = useState(variable?.value ?? "");
  const [visibility, setVisibility] = useState<Visibility>(
    variable?.visibility ?? "private",
  );
  const [selected, setSelected] = useState<string[]>(
    variable?.selectedRepositoryIds ?? [],
  );
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<ResultLike>();
  const [pending, startTransition] = useTransition();
  const done = result?.status === "succeeded";
  const nameOk = isVariableName(name);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await setOrgVariableAction({
              installationId,
              name,
              value,
              visibility,
              ...(visibility === "selected"
                ? { selectedRepositoryIds: selected }
                : {}),
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
      {!variable ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-name`} className="text-sm font-medium">
            {t("name")}
          </label>
          <input
            id={`${id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={255}
            required
            aria-invalid={name.length > 0 && !nameOk}
            className="h-9 rounded-md border bg-background px-3 font-mono text-sm"
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-value`} className="text-sm font-medium">
          {t("value")}
        </label>
        <textarea
          id={`${id}-value`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          rows={3}
          required
          maxLength={49_152}
          className="rounded-md border bg-background px-3 py-2 font-mono text-sm"
        />
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t("visibility")}</legend>
        {VISIBILITIES.map((v) => (
          <div key={v} className="flex items-center gap-2 text-sm">
            <input
              id={`${id}-vis-${v}`}
              type="radio"
              name={`${id}-visibility`}
              checked={visibility === v}
              onChange={() => setVisibility(v)}
            />
            <label htmlFor={`${id}-vis-${v}`}>{t(`visibilityOf.${v}`)}</label>
          </div>
        ))}
      </fieldset>
      {visibility === "selected" ? (
        <fieldset className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-2">
          <legend className="text-sm font-medium">
            {t("selectedRepositories")}
          </legend>
          {repos.map((r) => (
            <div
              key={r.repositoryId}
              className="flex items-center gap-2 text-sm"
            >
              <input
                id={`${id}-repo-${r.repositoryId}`}
                type="checkbox"
                checked={selected.includes(r.repositoryId)}
                onChange={(e) =>
                  setSelected((s) =>
                    e.target.checked
                      ? [...s, r.repositoryId]
                      : s.filter((x) => x !== r.repositoryId),
                  )
                }
              />
              <label htmlFor={`${id}-repo-${r.repositoryId}`}>
                {r.fullName}
              </label>
            </div>
          ))}
        </fieldset>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {tm("variablesNotSecrets")}
      </p>
      {nameOk ? (
        <TypedConfirmation
          id={`${id}-typed`}
          expected={name}
          value={typed}
          onChange={setTyped}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={
            pending ||
            done ||
            !nameOk ||
            value.length === 0 ||
            typed.trim() !== name
          }
        >
          {pending ? t("saving") : t("save")}
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}

function DeleteOrgVariablePanel({
  installationId,
  name,
  controls,
}: {
  installationId: string;
  name: string;
  controls: DialogControls;
}) {
  const t = useTranslations("management.variables");
  const id = useId();
  const [key] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState("");
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
            const res = await deleteOrgVariableAction({
              installationId,
              name,
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
      <p className="text-sm">{t("deleteOrgConfirm", { name })}</p>
      <TypedConfirmation
        id={`${id}-typed`}
        expected={name}
        value={typed}
        onChange={setTyped}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          disabled={pending || done || typed.trim() !== name}
        >
          {pending ? t("deleting") : t("delete")}
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}

export function OrgVariablesTable({
  installationId,
  variables,
  repos,
  canEdit,
  caption,
}: {
  installationId: string;
  variables: OrgVariableRow[];
  repos: RepoChoice[];
  canEdit: boolean;
  caption: string;
}) {
  const t = useTranslations("management.variables");
  const repoName = new Map(repos.map((r) => [r.repositoryId, r.fullName]));
  return (
    <div className="flex flex-col gap-3">
      {canEdit ? (
        <div>
          <ActionDialog trigger={t("newOrg")} title={t("newOrgTitle")}>
            {(controls) => (
              <OrgVariablePanel
                installationId={installationId}
                repos={repos}
                controls={controls}
              />
            )}
          </ActionDialog>
        </div>
      ) : null}
      {variables.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("orgEmpty")}</p>
      ) : (
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("name")}</TableHead>
              <TableHead scope="col">{t("value")}</TableHead>
              <TableHead scope="col">{t("visibility")}</TableHead>
              {canEdit ? (
                <TableHead scope="col">{t("actions")}</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {variables.map((v) => (
              <TableRow key={v.name}>
                <TableCell className="font-mono">{v.name}</TableCell>
                <TableCell>
                  <CellValue cell={v} />
                </TableCell>
                <TableCell className="text-xs">
                  {t(`visibilityOf.${v.visibility}`)}
                  {v.visibility === "selected" && v.selectedRepositoryIds ? (
                    <span className="block text-muted-foreground">
                      {v.selectedRepositoryIds
                        .map((id) => repoName.get(id) ?? id)
                        .join(", ") || "—"}
                    </span>
                  ) : null}
                </TableCell>
                {canEdit ? (
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <ActionDialog
                        trigger={t("edit")}
                        triggerLabel={t("editOrgFor", { name: v.name })}
                        triggerSize="xs"
                        triggerVariant="ghost"
                        title={t("editOrgTitle", { name: v.name })}
                      >
                        {(controls) => (
                          <OrgVariablePanel
                            installationId={installationId}
                            repos={repos}
                            variable={v}
                            controls={controls}
                          />
                        )}
                      </ActionDialog>
                      <ActionDialog
                        trigger={t("delete")}
                        triggerLabel={t("deleteOrgFor", { name: v.name })}
                        triggerSize="xs"
                        triggerVariant="ghost"
                        title={t("deleteOrgTitle", { name: v.name })}
                      >
                        {(controls) => (
                          <DeleteOrgVariablePanel
                            installationId={installationId}
                            name={v.name}
                            controls={controls}
                          />
                        )}
                      </ActionDialog>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
