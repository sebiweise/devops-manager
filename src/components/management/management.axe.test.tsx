// @vitest-environment jsdom
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { alert, auditEntry, pull, repoVars, run } from "./test-fixtures";

vi.mock("@/server/actions/runs", () => ({ runOperationAction: vi.fn() }));
vi.mock("@/server/actions/pulls", () => ({ mergePullRequestAction: vi.fn() }));
vi.mock("@/server/actions/management", () => ({
  setManagementEnabledAction: vi.fn(),
  setVariableRedactionAction: vi.fn(),
  verifyAuditChainAction: vi.fn(),
}));
vi.mock("@/server/actions/variables", () => ({
  setRepoVariableAction: vi.fn(),
  deleteRepoVariableAction: vi.fn(),
  previewBulkSetAction: vi.fn(),
  bulkSetVariableAction: vi.fn(),
  previewRevertAction: vi.fn(),
  revertBatchAction: vi.fn(),
  setOrgVariableAction: vi.fn(),
  deleteOrgVariableAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { RunActions, RunActionPanel } = await import("./run-actions");
const { ManagementBanner } = await import("./management-banner");
const { MergePanel, PullsTable } = await import("./pulls-table");
const { DeleteVariablePanel, SetVariablePanel, VariablesMatrix } =
  await import("./variable-editors");
const { OrgVariablePanel } = await import("./org-variables");
const { BulkVariableForm } = await import("./bulk-variable-form");
const { AuditTable } = await import("./audit-table");
const { AuditVerifyButton } = await import("./audit-verify");
const { ManagementSettings } = await import("./management-settings");
const { AlertsTable } = await import("./dependabot-table");

/**
 * axe-core over the management building blocks as the pages render them
 * (design §7): labelled controls, named buttons, live regions and table
 * semantics, with no critical or serious violations.
 */

const controls = { close: vi.fn(), changed: vi.fn() };

async function violations(node: React.ReactNode): Promise<string[]> {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={en}
      timeZone="UTC"
      now={new Date("2026-11-12T12:00:00Z")}
    >
      <main>
        <h1>Management</h1>
        {node}
      </main>
    </NextIntlClientProvider>,
  );
  document.documentElement.lang = "en";
  document.title = "Management";
  document.body.innerHTML = html;
  const result = await axe.run(document.body, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => v.id);
}

describe("management UI passes axe", () => {
  it("run actions and the run dialog", async () => {
    expect(
      await violations(
        <>
          <ManagementBanner
            state={{ globalEnabled: true, installationEnabled: false }}
            settingsHref="/o/example-org/settings"
          />
          <RunActions installationId="42" run={run()} />
          <RunActions
            installationId="42"
            run={run({ id: "9002", status: "IN_PROGRESS", conclusion: null })}
            forceCancelAvailable
            compact
          />
          <RunActionPanel
            installationId="42"
            run={run()}
            operation="rerun_failed"
            controls={controls}
          />
        </>,
      ),
    ).toEqual([]);
  });

  it("pull requests and the merge dialog", async () => {
    expect(
      await violations(
        <>
          <PullsTable
            installationId="42"
            pulls={[pull(), pull({ number: 8, changesWorkflows: true })]}
            mergeMethods={{ "101": ["merge", "squash"] }}
            workflowsGranted={false}
            canMerge
            mergeAuditTrailer={false}
            caption="Pull requests"
          />
          <MergePanel
            installationId="42"
            pull={pull({ mergeStateStatus: "BEHIND" })}
            methods={["merge", "squash", "rebase"]}
            mergeAuditTrailer
            controls={controls}
          />
        </>,
      ),
    ).toEqual([]);
  });

  it("variables, the editors and the bulk form", async () => {
    expect(
      await violations(
        <>
          <VariablesMatrix
            installationId="42"
            names={["LINUX_RUNNER", "MACOS_RUNNER"]}
            repos={[repoVars()]}
            canEdit
            caption="Repository variables"
          />
          <SetVariablePanel
            installationId="42"
            repos={[{ repositoryId: "101", fullName: "example-org/repo-a" }]}
            current={null}
            controls={controls}
          />
          <DeleteVariablePanel
            installationId="42"
            repositoryId="101"
            repoFullName="example-org/repo-a"
            name="LINUX_RUNNER"
            current="runner-1"
            controls={controls}
          />
          <OrgVariablePanel
            installationId="42"
            repos={[{ repositoryId: "101", fullName: "example-org/repo-a" }]}
            variable={{
              name: "SHARED",
              value: "x",
              masked: false,
              updatedAt: null,
              visibility: "selected",
              selectedRepositoryIds: ["101"],
            }}
            controls={controls}
          />
          <BulkVariableForm
            installationId="42"
            presets={[
              {
                name: "LINUX_RUNNER",
                values: ["runner-1", "ubuntu-latest"],
                scope: "repository",
              },
            ]}
            repos={[
              {
                repositoryId: "101",
                fullName: "example-org/repo-a",
                archived: false,
              },
            ]}
          />
        </>,
      ),
    ).toEqual([]);
  });

  it("audit log, settings and Dependabot", async () => {
    expect(
      await violations(
        <>
          <AuditVerifyButton installationId="42" />
          <AuditTable
            entries={[
              auditEntry(),
              auditEntry({
                id: "audit-2",
                seq: "42",
                action: "PR_MERGE",
                status: "FAILED",
                targetType: "pull",
                targetId: "7",
                batchId: null,
                repoFullName: "example-org/repo-a",
                httpStatus: 409,
                error:
                  "Head branch was modified. Review and try the merge again.",
              }),
            ]}
            caption="Audit log"
            batchHref={(b) => `/o/example-org/variables/batches/${b}`}
            filterHref={() => "/o/example-org/audit"}
            canRevert
          />
          <ManagementSettings
            installationId="42"
            globalEnabled
            managementEnabled={false}
            redactVariableValues={false}
          />
          <AlertsTable alerts={[alert()]} caption="Dependabot alerts" />
        </>,
      ),
    ).toEqual([]);
  });
});
