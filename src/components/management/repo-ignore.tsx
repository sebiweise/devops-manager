"use client";

import { Ellipsis, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { useSelection } from "@/components/data/selection";
import { HeaderMenu } from "@/components/shell/menu";
import { Button } from "@/components/ui/button";
import type { ResultLike } from "@/lib/management-view";
import {
  ignoreRepositoriesAction,
  unignoreRepositoriesAction,
} from "@/server/actions/repos";
import {
  ActionDialog,
  ResultMessage,
  type DialogControls,
} from "./action-dialog";

/**
 * Ignore and un-ignore repositories (admin, UI overhaul §3.4): a dialog with
 * the list of names, what happens to the stored data, an explicit checkbox
 * confirmation (DIALOG) and the result. The server enforces the role and
 * audits one row per repository.
 */

export type IgnoreRepo = { id: string; fullName: string; fork?: boolean };
export type IgnoreMode = "ignore" | "unignore";

type Outcome = { changed: number; failed: number };

function outcomeOf(res: unknown): Outcome | null {
  const r = res as { status?: string; data?: Outcome | null };
  if ((r.status === "succeeded" || r.status === "failed") && r.data)
    return { changed: r.data.changed, failed: r.data.failed };
  return null;
}

function IgnorePanel({
  installationId,
  repos,
  mode,
  controls,
}: {
  installationId: string;
  repos: IgnoreRepo[];
  mode: IgnoreMode;
  controls: DialogControls;
}) {
  const t = useTranslations("ignore");
  const [key] = useState(() => crypto.randomUUID());
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<ResultLike>();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();
  const checkId = useId();
  const done = outcome !== null && outcome.failed === 0;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          try {
            const action =
              mode === "ignore"
                ? ignoreRepositoriesAction
                : unignoreRepositoriesAction;
            const res = await action({
              installationId,
              repositoryIds: repos.map((r) => r.id),
              confirmed,
              idempotencyKey: key,
            });
            const o = outcomeOf(res);
            setOutcome(o);
            setResult(o ? undefined : res);
            if (o && o.changed > 0) controls.changed();
          } catch {
            setResult({ status: "error" });
          }
        });
      }}
    >
      <ul
        aria-label={t("dialog.listLabel")}
        className="max-h-48 overflow-y-auto rounded-md border p-2 text-sm"
      >
        {repos.map((r) => (
          <li key={r.id} className="flex items-center gap-2 py-0.5">
            <span className="truncate">{r.fullName}</span>
            {r.fork ? <Badge variant="outline">{t("badge.fork")}</Badge> : null}
          </li>
        ))}
      </ul>
      <p className="text-sm">
        {mode === "ignore" ? t("dialog.bodyIgnore") : t("dialog.bodyUnignore")}
      </p>
      <label htmlFor={checkId} className="flex items-start gap-2 text-sm">
        <input
          id={checkId}
          type="checkbox"
          className="mt-1"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={done}
        />
        <span>
          {mode === "ignore"
            ? t("dialog.confirmIgnore", { count: repos.length })
            : t("dialog.confirmUnignore", { count: repos.length })}
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          size="sm"
          variant={mode === "ignore" ? "destructive" : "default"}
          disabled={!confirmed || pending || done}
        >
          {mode === "ignore"
            ? t("dialog.submitIgnore", { count: repos.length })
            : t("dialog.submitUnignore", { count: repos.length })}
        </Button>
        {outcome ? (
          <p role="status" aria-live="polite" className="text-sm">
            {mode === "ignore"
              ? t("result.ignored", { count: outcome.changed })
              : t("result.unignored", { count: outcome.changed })}
            {outcome.failed > 0
              ? ` ${t("result.failed", { count: outcome.failed })}`
              : ""}
          </p>
        ) : (
          <ResultMessage result={result} />
        )}
      </div>
    </form>
  );
}

/** A button that opens the ignore (or un-ignore) dialog for `repos`. */
export function RepoIgnoreButton({
  installationId,
  repos,
  mode,
  label,
  variant = "outline",
}: {
  installationId: string;
  repos: IgnoreRepo[];
  mode: IgnoreMode;
  /** Trigger text; defaults to "Ignore" / "Un-ignore". */
  label?: string;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
}) {
  const t = useTranslations("ignore");
  const title =
    mode === "ignore"
      ? t("dialog.titleIgnore", { count: repos.length })
      : t("dialog.titleUnignore", { count: repos.length });
  const text =
    label ?? (mode === "ignore" ? t("action.ignore") : t("action.unignore"));
  return (
    <ActionDialog
      trigger={text}
      // A row action names its repository; the visible text stays the start
      // of the accessible name.
      triggerLabel={
        !label && repos.length === 1
          ? `${text} ${repos[0]!.fullName}`
          : undefined
      }
      title={title}
      triggerVariant={variant}
      disabled={repos.length === 0}
    >
      {(controls) => (
        <IgnorePanel
          installationId={installationId}
          repos={repos}
          mode={mode}
          controls={controls}
        />
      )}
    </ActionDialog>
  );
}

/**
 * The temporary repository list of the settings page (until the repositories
 * page gets its selection column): active repos with checkboxes, a "forks
 * only" filter and "Ignore selected"; ignored repos with un-ignore.
 */
export function RepoIgnoreList({
  installationId,
  repos,
}: {
  installationId: string;
  repos: Array<IgnoreRepo & { private: boolean; archived: boolean }>;
}) {
  const t = useTranslations("ignore");
  const [forksOnly, setForksOnly] = useState(false);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visible = useMemo(
    () =>
      repos.filter(
        (r) =>
          (!forksOnly || r.fork) &&
          r.fullName.toLowerCase().includes(q.trim().toLowerCase()),
      ),
    [repos, forksOnly, q],
  );
  const chosen = repos.filter((r) => selected.has(r.id));
  const allVisible =
    visible.length > 0 && visible.every((r) => selected.has(r.id));
  const searchId = useId();
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={searchId} className="sr-only">
          {t("list.search")}
        </label>
        <input
          id={searchId}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("list.search")}
          className="h-8 rounded-md border bg-background px-2 text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant={forksOnly ? "secondary" : "outline"}
          aria-pressed={forksOnly}
          onClick={() => setForksOnly((v) => !v)}
        >
          {t("list.forksOnly")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            setSelected((s) => {
              const n = new Set(s);
              for (const r of visible) {
                if (allVisible) n.delete(r.id);
                else n.add(r.id);
              }
              return n;
            })
          }
          disabled={visible.length === 0}
        >
          {allVisible
            ? t("list.clearShown")
            : t("list.selectShown", { count: visible.length })}
        </Button>
        <RepoIgnoreButton
          installationId={installationId}
          repos={chosen}
          mode="ignore"
          variant="destructive"
          label={t("action.ignoreSelected", { count: chosen.length })}
        />
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("list.empty")}</p>
      ) : (
        <ul
          aria-label={t("list.label")}
          className="max-h-80 overflow-y-auto rounded-md border p-2 text-sm"
        >
          {visible.map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-0.5">
              <input
                type="checkbox"
                id={`ignore-${r.id}`}
                checked={selected.has(r.id)}
                onChange={(e) => toggle(r.id, e.target.checked)}
              />
              <label htmlFor={`ignore-${r.id}`} className="truncate">
                {r.fullName}
              </label>
              {r.fork ? (
                <Badge variant="outline">{t("badge.fork")}</Badge>
              ) : null}
              {r.private ? (
                <Badge variant="secondary">{t("badge.private")}</Badge>
              ) : null}
              {r.archived ? (
                <Badge variant="outline">{t("badge.archived")}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Ignore selected (n)" for the selection bar of the repositories table. */
export function IgnoreSelectedButton({
  installationId,
}: {
  installationId: string;
}) {
  const t = useTranslations("ignore");
  const s = useSelection();
  const repos = [...s.selected.values()].map((i) => ({
    id: i.id,
    fullName: i.label,
    fork: i.fork,
  }));
  return (
    <RepoIgnoreButton
      installationId={installationId}
      repos={repos}
      mode="ignore"
      variant="destructive"
      label={t("action.ignoreSelected", { count: repos.length })}
    />
  );
}

/**
 * The "…" menu of a repository row (admin): Ignore or Un-ignore, and Open
 * on GitHub. The dialog opens from inside the menu and keeps it open until
 * it is closed.
 */
export function RepoRowMenu({
  installationId,
  repo,
  ignored,
  canIgnore,
}: {
  installationId: string;
  repo: IgnoreRepo;
  ignored: boolean;
  canIgnore: boolean;
}) {
  const t = useTranslations("ignore");
  return (
    <HeaderMenu
      label={t("rowMenu", { name: repo.fullName })}
      trigger={<Ellipsis aria-hidden="true" className="size-4" />}
      panelClassName="w-56"
    >
      <div className="flex flex-col items-stretch gap-0.5 [&_button]:w-full [&_button]:justify-start">
        {canIgnore ? (
          <RepoIgnoreButton
            installationId={installationId}
            repos={[repo]}
            mode={ignored ? "unignore" : "ignore"}
            variant="ghost"
          />
        ) : null}
        <a
          href={`https://github.com/${repo.fullName
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-accent"
        >
          <ExternalLink aria-hidden="true" className="size-4" />
          {t("openOnGitHub")}
        </a>
      </div>
    </HeaderMenu>
  );
}
