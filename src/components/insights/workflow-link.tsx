import Link from "next/link";
import { accountPath } from "@/lib/account-page";

/** Link to the workflow page: /o/[account]/repos/[repo]/workflows/[id]. */
export function workflowHref(
  accountLogin: string,
  repoFullName: string,
  workflowId: string,
): string {
  const repo = repoFullName.split("/").pop() ?? repoFullName;
  return accountPath(
    accountLogin,
    `/repos/${encodeURIComponent(repo)}/workflows/${encodeURIComponent(workflowId)}`,
  );
}

export function repoHref(accountLogin: string, repoFullName: string): string {
  const repo = repoFullName.split("/").pop() ?? repoFullName;
  return accountPath(accountLogin, `/repos/${encodeURIComponent(repo)}`);
}

export function runHref(accountLogin: string, runId: string, attempt?: number) {
  return accountPath(
    accountLogin,
    `/runs/${encodeURIComponent(runId)}${attempt ? `?attempt=${attempt}` : ""}`,
  );
}

export function WorkflowLink({
  accountLogin,
  repoFullName,
  workflowId,
  workflowName,
}: {
  accountLogin: string;
  repoFullName: string;
  workflowId: string;
  workflowName: string;
}) {
  return (
    <Link
      className="underline-offset-2 hover:underline"
      href={workflowHref(accountLogin, repoFullName, workflowId)}
    >
      <span className="font-medium">{workflowName || workflowId}</span>
      <span className="text-muted-foreground"> · {repoFullName}</span>
    </Link>
  );
}
