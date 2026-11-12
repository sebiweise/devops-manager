import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { withParams } from "@/lib/url-state";

/**
 * Breadcrumbs of the detail pages (UI overhaul §1.3), built from typed
 * segments so every page names its path the same way:
 * Accounts / example-org / Repositories / repo-a / Workflow "CI" / Run #123.
 * Every link keeps `?range=`; the last item is the current page.
 */

export type Crumb =
  | { kind: "accounts" }
  | { kind: "account"; login: string }
  | {
      kind: "section";
      login: string;
      section:
        | "repos"
        | "workflows"
        | "runners"
        | "queue"
        | "costs"
        | "settings"
        | "audit";
    }
  | { kind: "repo"; login: string; name: string; fullName: string }
  | {
      kind: "workflow";
      login: string;
      repoFullName: string;
      name: string;
      id: string;
    }
  | {
      kind: "run";
      login: string;
      id: string;
      number: number | null;
      attempt: number;
    }
  | { kind: "runner"; login: string; key: string; name: string };

const acct = (login: string) => `/o/${encodeURIComponent(login)}`;

export function crumbHref(c: Crumb): string {
  switch (c.kind) {
    case "accounts":
      return "/dashboard";
    case "account":
      return acct(c.login);
    case "section":
      return `${acct(c.login)}/${c.section}`;
    case "repo":
      return `${acct(c.login)}/repos/${encodeURIComponent(c.fullName.split("/")[1] ?? c.name)}`;
    case "workflow":
      return `${acct(c.login)}/repos/${encodeURIComponent(c.repoFullName.split("/")[1] ?? "")}/workflows/${c.id}`;
    case "run":
      return `${acct(c.login)}/runs/${c.id}`;
    case "runner":
      return `${acct(c.login)}/runners/${encodeURIComponent(c.key)}`;
  }
}

export function Breadcrumbs({
  items,
  range,
}: {
  items: ReadonlyArray<Crumb>;
  /** Kept on every link. */
  range?: string;
}) {
  const t = useTranslations("breadcrumbs");
  const text = (c: Crumb): string => {
    switch (c.kind) {
      case "accounts":
        return t("accounts");
      case "account":
        return c.login;
      case "section":
        return t(`sections.${c.section}`);
      case "repo":
        return c.name;
      case "workflow":
        return t("workflow", { name: c.name });
      case "run":
        return c.attempt > 1
          ? t("runAttempt", { number: c.number ?? c.id, attempt: c.attempt })
          : t("run", { number: c.number ?? c.id });
      case "runner":
        return c.name;
    }
  };
  return (
    <nav aria-label={t("label")}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-1">
              {last ? (
                <span aria-current="page" className="text-foreground">
                  {text(c)}
                </span>
              ) : (
                <>
                  <Link
                    href={withParams(crumbHref(c), { range })}
                    className="underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {text(c)}
                  </Link>
                  <ChevronRight aria-hidden="true" className="size-3" />
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
