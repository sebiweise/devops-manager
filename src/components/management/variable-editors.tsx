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
  deleteRepoVariableAction,
  setRepoVariableAction,
} from "@/server/actions/variables";
import type { RepoVariables, VariableCell } from "@/server/data/variables";
import {
  ActionDialog,
  ResultMessage,
  type DialogControls,
} from "./action-dialog";
import { compareCodeUnits } from "@/lib/compare";

/**
 * Repository variables (design §7 /variables, §8.2 #5): the matrix of
 * variable name × repo, a per-repo list for the repository page, and the
 * set and delete dialogs. Set shows the diff (old → new) and is pinned to
 * the value the dialog showed; delete needs the variable name typed.
 * Viewers and operators only read (masked when the redaction setting is
 * on); the edit controls exist only for admins while management is on.
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Client-side hint only; the server applies GitHub's rules. */
export function isVariableName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    NAME_RE.test(name) &&
    !/^github_/i.test(name)
  );
}

const inputClass =
  "h-9 rounded-md border bg-background px-3 font-mono text-sm aria-invalid:border-destructive";

export function CellValue({ cell }: { cell: VariableCell | undefined }) {
  const t = useTranslations("management.variables");
  if (!cell) return <span className="text-muted-foreground">—</span>;
  if (cell.masked)
    return <span className="text-muted-foreground italic">{t("masked")}</span>;
  return (
    <span
      className="block max-w-56 truncate font-mono text-xs"
      title={cell.value ?? undefined}
    >
      {cell.value}
    </span>
  );
}

function Diff({
  before,
  after,
}: {
  before: string | null;
  after: string | null;
}) {
  const t = useTranslations("management.variables");
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">{t("before")}</dt>
      <dd className="font-mono break-all">
        {before ?? <span className="font-sans italic">{t("notSet")}</span>}
      </dd>
      <dt className="text-muted-foreground">{t("after")}</dt>
      <dd className="font-mono break-all">
        {after ?? <span className="font-sans italic">{t("deleted")}</span>}
      </dd>
    </dl>
  );
}

export type RepoChoice = { repositoryId: string; fullName: string };

/** Create or update one repository variable. */
export function SetVariablePanel({
  installationId,
  repos,
  repositoryId: fixedRepo,
  name: fixedName,
  current,
  controls,
}: {
  installationId: string;
  /** For a new variable: the repos to choose from. */
  repos?: RepoChoice[];
  repositoryId?: string;
  name?: string;
  /** The value the matrix showed (null = not set). */
  current: string | null;
  controls: DialogControls;
}) {
  const t = useTranslations("management.variables");
  const tm = useTranslations("management");
  const id = useId();
  const [key] = useState(() => crypto.randomUUID());
  const [repositoryId, setRepositoryId] = useState(
    fixedRepo ?? repos?.[0]?.repositoryId ?? "",
  );
  const [name, setName] = useState(fixedName ?? "");
  const [value, setValue] = useState(current ?? "");
  const [result, setResult] = useState<ResultLike>();
  const [pending, startTransition] = useTransition();
  const nameOk = isVariableName(name);
  const changed = value.length > 0 && value !== current;
  const done = result?.status === "succeeded";

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const res = await setRepoVariableAction({
              installationId,
              repositoryId,
              name,
              value,
              expectedBefore: fixedName ? current : undefined,
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
      {!fixedRepo && repos ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-repo`} className="text-sm font-medium">
            {t("repository")}
          </label>
          <select
            id={`${id}-repo`}
            value={repositoryId}
            onChange={(e) => setRepositoryId(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {repos.map((r) => (
              <option key={r.repositoryId} value={r.repositoryId}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {!fixedName ? (
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
            aria-describedby={`${id}-name-hint`}
            className={inputClass}
          />
          <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">
            {tm("refused.invalid_name")}
          </p>
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
      <Diff before={current} after={value || null} />
      <p className="text-xs text-muted-foreground">
        {tm("variablesNotSecrets")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={pending || done || !nameOk || !changed || !repositoryId}
        >
          {pending ? t("saving") : t("save")}
        </Button>
        <ResultMessage result={result} />
      </div>
    </form>
  );
}

/** Delete one repository variable; the name must be typed. */
export function DeleteVariablePanel({
  installationId,
  repositoryId,
  repoFullName,
  name,
  current,
  controls,
}: {
  installationId: string;
  repositoryId: string;
  repoFullName: string;
  name: string;
  current: string | null;
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
            const res = await deleteRepoVariableAction({
              installationId,
              repositoryId,
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
      <p className="text-sm">
        {t("deleteConfirm", { name, repo: repoFullName })}
      </p>
      <Diff before={current} after={null} />
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

/** A labelled text field that must equal `expected` (TYPED confirmation). */
export function TypedConfirmation({
  id,
  expected,
  value,
  onChange,
}: {
  id: string;
  expected: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("management");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {t("typeToConfirm", { text: expected })}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        maxLength={300}
        required
        className={inputClass}
      />
    </div>
  );
}

function CellActions({
  installationId,
  repo,
  name,
  cell,
}: {
  installationId: string;
  repo: RepoVariables;
  name: string;
  cell: VariableCell | undefined;
}) {
  const t = useTranslations("management.variables");
  const current = cell?.value ?? null;
  return (
    <div className="flex flex-wrap gap-1">
      <ActionDialog
        trigger={cell ? t("edit") : t("set")}
        triggerLabel={t(cell ? "editFor" : "setFor", {
          name,
          repo: repo.fullName,
        })}
        triggerSize="xs"
        triggerVariant="ghost"
        title={t(cell ? "editTitle" : "setTitle", {
          name,
          repo: repo.fullName,
        })}
      >
        {(controls) => (
          <SetVariablePanel
            installationId={installationId}
            repositoryId={repo.repositoryId}
            name={name}
            current={current}
            controls={controls}
          />
        )}
      </ActionDialog>
      {cell ? (
        <ActionDialog
          trigger={t("delete")}
          triggerLabel={t("deleteFor", { name, repo: repo.fullName })}
          triggerSize="xs"
          triggerVariant="ghost"
          title={t("deleteTitle", { name, repo: repo.fullName })}
        >
          {(controls) => (
            <DeleteVariablePanel
              installationId={installationId}
              repositoryId={repo.repositoryId}
              repoFullName={repo.fullName}
              name={name}
              current={current}
              controls={controls}
            />
          )}
        </ActionDialog>
      ) : null}
    </div>
  );
}

/** "New variable" (admin): choose the repo, the name and the value. */
export function NewVariableButton({
  installationId,
  repos,
}: {
  installationId: string;
  repos: RepoChoice[];
}) {
  const t = useTranslations("management.variables");
  if (repos.length === 0) return null;
  return (
    <ActionDialog trigger={t("new")} title={t("newTitle")}>
      {(controls) => (
        <SetVariablePanel
          installationId={installationId}
          repos={repos}
          current={null}
          controls={controls}
        />
      )}
    </ActionDialog>
  );
}

/** Matrix of variable name (columns) × repository (rows). */
export function VariablesMatrix({
  installationId,
  names,
  repos,
  canEdit,
  caption,
}: {
  installationId: string;
  names: string[];
  repos: RepoVariables[];
  canEdit: boolean;
  caption: string;
}) {
  const t = useTranslations("management.variables");
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("repository")}</TableHead>
          {names.map((n) => (
            <TableHead key={n} scope="col" className="font-mono">
              {n}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {repos.map((r) => (
          <TableRow key={r.repositoryId}>
            <TableHead scope="row" className="font-medium">
              {r.fullName}
              {r.archived ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  {t("archived")}
                </span>
              ) : null}
            </TableHead>
            {names.map((n) => (
              <TableCell key={n}>
                {r.status === "unavailable" ? (
                  <span className="text-xs text-muted-foreground">
                    {t("unavailable")}
                  </span>
                ) : (
                  <div className="flex flex-col gap-1">
                    <CellValue cell={r.variables[n]} />
                    {canEdit && !r.archived ? (
                      <CellActions
                        installationId={installationId}
                        repo={r}
                        name={n}
                        cell={r.variables[n]}
                      />
                    ) : null}
                  </div>
                )}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One repository's variables as a list (repository page tab). */
export function RepoVariablesList({
  installationId,
  repo,
  canEdit,
  caption,
}: {
  installationId: string;
  repo: RepoVariables;
  canEdit: boolean;
  caption: string;
}) {
  const t = useTranslations("management.variables");
  const names = Object.keys(repo.variables).sort(compareCodeUnits);
  if (repo.status === "unavailable")
    return <p className="text-sm text-muted-foreground">{t("unavailable")}</p>;
  return (
    <div className="flex flex-col gap-3">
      {canEdit && !repo.archived ? (
        <div>
          <ActionDialog trigger={t("new")} title={t("newTitle")}>
            {(controls) => (
              <SetVariablePanel
                installationId={installationId}
                repositoryId={repo.repositoryId}
                current={null}
                controls={controls}
              />
            )}
          </ActionDialog>
        </div>
      ) : null}
      {names.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("name")}</TableHead>
              <TableHead scope="col">{t("value")}</TableHead>
              {canEdit ? (
                <TableHead scope="col">{t("actions")}</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {names.map((n) => (
              <TableRow key={n}>
                <TableCell className="font-mono">{n}</TableCell>
                <TableCell>
                  <CellValue cell={repo.variables[n]} />
                </TableCell>
                {canEdit ? (
                  <TableCell>
                    {repo.archived ? null : (
                      <CellActions
                        installationId={installationId}
                        repo={repo}
                        name={n}
                        cell={repo.variables[n]}
                      />
                    )}
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
