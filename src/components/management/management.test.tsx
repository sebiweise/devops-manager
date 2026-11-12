import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { alert, auditEntry, pull, repoVars, run } from "./test-fixtures";

// The Server Actions and the router are not needed to render the UI.
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
const { DeleteVariablePanel, RepoVariablesList, VariablesMatrix } =
  await import("./variable-editors");
const { OrgVariablesTable } = await import("./org-variables");
const { BulkVariableForm, BulkResultView } =
  await import("./bulk-variable-form");
const { RevertBatchForm } = await import("./revert-batch");
const { AuditTable } = await import("./audit-table");
const { VerifyResult } = await import("./audit-verify");
const { ManagementSettings } = await import("./management-settings");
const { AlertsTable, SeverityMatrix, matchingPull } =
  await import("./dependabot-table");

/**
 * The management UI (design §7, §8): buttons exist only for the roles and
 * states that may use them, dialogs name what they act on, typed
 * confirmations gate destructive actions, and the audit log shows the app
 * user next to the App identity.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? en : de}
      timeZone="UTC"
      now={new Date("2026-11-12T12:00:00Z")}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const controls = { close: vi.fn(), changed: vi.fn() };

describe("RunActions", () => {
  it("offers re-run and re-run failed for a failed run", () => {
    const html = render(<RunActions installationId="42" run={run()} />);
    expect(html).toContain(">Re-run all jobs</button>");
    expect(html).toContain(">Re-run failed jobs</button>");
    expect(html).not.toContain("Cancel run");
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("offers only re-run for a successful run and nothing at 50 attempts", () => {
    const ok = render(
      <RunActions installationId="42" run={run({ conclusion: "SUCCESS" })} />,
    );
    expect(ok).toContain("Re-run all jobs");
    expect(ok).not.toContain("Re-run failed jobs");
    expect(
      render(
        <RunActions
          installationId="42"
          run={run({ conclusion: "SUCCESS", runAttempt: 50 })}
        />,
      ),
    ).toBe("");
  });

  it("offers cancel while running and force cancel only when allowed", () => {
    const running = run({ status: "IN_PROGRESS", conclusion: null });
    const html = render(<RunActions installationId="42" run={running} />);
    expect(html).toContain(">Cancel run</button>");
    expect(html).not.toContain("Force cancel");
    expect(
      render(
        <RunActions installationId="42" run={running} forceCancelAvailable />,
      ),
    ).toContain(">Force cancel</button>");
  });

  it("renders nothing for placeholder runs", () => {
    expect(
      render(
        <RunActions installationId="42" run={run({ isPlaceholder: true })} />,
      ),
    ).toBe("");
  });

  it("names the run in compact buttons", () => {
    const html = render(<RunActions installationId="42" run={run()} compact />);
    expect(html).toContain('aria-label="Re-run all jobs: run #12"');
  });

  it("the dialog names repo, workflow, run and attempt and the App actor", () => {
    const html = render(
      <RunActionPanel
        installationId="42"
        run={run({ runAttempt: 2 })}
        operation="rerun"
        controls={controls}
      />,
    );
    expect(html).toContain("example-org/repo-a");
    expect(html).toContain(">CI<");
    expect(html).toContain(">#12<");
    expect(html).toContain(">2<");
    expect(html).toMatch(/<label for="[^"]+-debug">Enable debug logging/);
    expect(html).toContain("GitHub shows the App&#x27;s bot as the actor");
  });
});

describe("ManagementBanner", () => {
  it("is absent while both switches are on", () => {
    expect(
      render(
        <ManagementBanner
          state={{ globalEnabled: true, installationEnabled: true }}
        />,
      ),
    ).toBe("");
  });

  it("explains the global kill switch", () => {
    const html = render(
      <ManagementBanner
        state={{ globalEnabled: false, installationEnabled: true }}
        settingsHref="/o/example-org/settings"
      />,
    );
    expect(html).toContain("Management is turned off for this instance.");
    expect(html).toContain("MANAGEMENT_ENABLED=true");
    expect(html).not.toContain("/o/example-org/settings");
  });

  it("links admins to the installation toggle", () => {
    const html = render(
      <ManagementBanner
        state={{ globalEnabled: true, installationEnabled: false }}
        settingsHref="/o/example-org/settings"
      />,
    );
    expect(html).toContain("turned off for this installation");
    expect(html).toContain('href="/o/example-org/settings"');
  });
});

describe("PullsTable and MergePanel", () => {
  const props = {
    installationId: "42",
    workflowsGranted: false,
    mergeAuditTrailer: false,
    caption: "Pull requests",
  };

  it("has no merge column for non-admins", () => {
    const html = render(
      <PullsTable
        {...props}
        mergeMethods={{ "101": ["merge", "squash"] }}
        pulls={[pull()]}
        canMerge={false}
      />,
    );
    expect(html).toContain("#7 Bump actions/checkout from 4 to 5");
    expect(html).toContain(">Dependabot<");
    expect(html).not.toContain(">Merge</button>");
    expect(html).not.toContain(">Actions<");
  });

  it("offers merge for a clean PR and explains blocked ones", () => {
    const html = render(
      <PullsTable
        {...props}
        mergeMethods={{ "101": ["merge", "squash"] }}
        pulls={[
          pull(),
          pull({ number: 8, changesWorkflows: true }),
          pull({ number: 9, isDraft: true }),
          pull({ number: 10, mergeable: "CONFLICTING" }),
        ]}
        canMerge
      />,
    );
    expect(html).toContain(
      'aria-label="Merge pull request #7 in example-org/repo-a"',
    );
    expect(html).toContain(
      "changes workflows; the App has no Workflows: write",
    );
    expect(html).toContain(">draft<");
    expect(html).toContain("has conflicts");
    expect(html).not.toContain("Merge pull request #8");
  });

  it("shows an empty state", () => {
    expect(
      render(<PullsTable {...props} mergeMethods={{}} pulls={[]} canMerge />),
    ).toContain("No open pull requests.");
  });

  it("preselects squash and needs the warning checkbox when not CLEAN", () => {
    const html = render(
      <MergePanel
        installationId="42"
        pull={pull({ mergeStateStatus: "BLOCKED", changesWorkflows: true })}
        methods={["merge", "squash"]}
        mergeAuditTrailer
        controls={controls}
      />,
    );
    expect(html).toMatch(
      /<input id="[^"]+-m-squash" type="radio"[^>]*checked=""/,
    );
    expect(html).not.toMatch(/<input id="[^"]+-m-merge"[^>]*checked=""/);
    expect(html).toContain("merge state BLOCKED, not CLEAN");
    expect(html).toContain(".github/workflows");
    expect(html).toContain("DevOps-Manager-Audit");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("does not ask for the warning on a CLEAN PR", () => {
    const html = render(
      <MergePanel
        installationId="42"
        pull={pull()}
        methods={["merge"]}
        mergeAuditTrailer={false}
        controls={controls}
      />,
    );
    expect(html).not.toContain("not CLEAN");
    expect(html).not.toContain("DevOps-Manager-Audit");
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});

describe("variables", () => {
  it("viewers see values without edit controls", () => {
    const html = render(
      <VariablesMatrix
        installationId="42"
        names={["LINUX_RUNNER", "MACOS_RUNNER"]}
        repos={[repoVars()]}
        canEdit={false}
        caption="Repository variables"
      />,
    );
    expect(html).toContain("runner-1");
    expect(html).toContain(">LINUX_RUNNER<");
    expect(html).not.toContain("<button");
  });

  it("masked values are not rendered", () => {
    const html = render(
      <VariablesMatrix
        installationId="42"
        names={["LINUX_RUNNER"]}
        repos={[
          repoVars({
            variables: {
              LINUX_RUNNER: { value: null, masked: true, updatedAt: null },
            },
          }),
        ]}
        canEdit={false}
        caption="Repository variables"
      />,
    );
    expect(html).toContain(">hidden<");
    expect(html).not.toContain("runner-1");
  });

  it("admins get edit, set and delete per cell, not on archived repos", () => {
    const html = render(
      <VariablesMatrix
        installationId="42"
        names={["LINUX_RUNNER", "MACOS_RUNNER"]}
        repos={[
          repoVars(),
          repoVars({
            repositoryId: "102",
            fullName: "example-org/repo-b",
            archived: true,
          }),
        ]}
        canEdit
        caption="Repository variables"
      />,
    );
    expect(html).toContain(
      'aria-label="Edit LINUX_RUNNER in example-org/repo-a"',
    );
    expect(html).toContain(
      'aria-label="Delete LINUX_RUNNER in example-org/repo-a"',
    );
    expect(html).toContain(
      'aria-label="Set MACOS_RUNNER in example-org/repo-a"',
    );
    expect(html).not.toContain("in example-org/repo-b");
  });

  it("the repository list shows an empty state", () => {
    const html = render(
      <RepoVariablesList
        installationId="42"
        repo={repoVars({ variables: {} })}
        canEdit={false}
        caption="Variables"
      />,
    );
    expect(html).toContain("This repository has no variables.");
  });

  it("delete needs the variable name typed", () => {
    const html = render(
      <DeleteVariablePanel
        installationId="42"
        repositoryId="101"
        repoFullName="example-org/repo-a"
        name="LINUX_RUNNER"
        current="runner-1"
        controls={controls}
      />,
    );
    expect(html).toContain("Type LINUX_RUNNER to confirm");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Delete<\/button>/);
    expect(html).toContain("runner-1");
  });

  it("org variables show visibility and the selected repos", () => {
    const html = render(
      <OrgVariablesTable
        installationId="42"
        variables={[
          {
            name: "SHARED",
            value: "x",
            masked: false,
            updatedAt: null,
            visibility: "selected",
            selectedRepositoryIds: ["101"],
          },
        ]}
        repos={[{ repositoryId: "101", fullName: "example-org/repo-a" }]}
        canEdit
        caption="Organisation variables"
      />,
    );
    expect(html).toContain("Selected repositories");
    expect(html).toContain("example-org/repo-a");
    expect(html).toContain('aria-label="Delete organisation variable SHARED"');
  });
});

describe("bulk set and revert", () => {
  it("offers the presets and preselects the active, unarchived repos", () => {
    const html = render(
      <BulkVariableForm
        installationId="42"
        presets={[
          {
            name: "LINUX_RUNNER",
            values: ["runner-1", "ubuntu-latest"],
            scope: "repository",
          },
          {
            name: "MACOS_RUNNER",
            values: ["runner-1", "macos-latest"],
            scope: "repository",
          },
        ]}
        repos={[
          {
            repositoryId: "101",
            fullName: "example-org/repo-a",
            archived: false,
          },
          {
            repositoryId: "102",
            fullName: "example-org/repo-b",
            archived: true,
          },
        ]}
      />,
    );
    expect(html).toContain(">LINUX_RUNNER</label>");
    expect(html).toContain(">MACOS_RUNNER</label>");
    expect(html).toContain(">ubuntu-latest</label>");
    expect(html).toContain("1 repository selected");
    expect(html).toMatch(/id="[^"]+-repo-101" type="checkbox" checked=""/);
    expect(html).not.toMatch(/id="[^"]+-repo-102" type="checkbox" checked=""/);
    expect(html).toContain(">Preview changes</button>");
    // No apply before a preview exists.
    expect(html).not.toContain(">Apply</button>");
  });

  it("lists the per-repo results", () => {
    const html = render(
      <BulkResultView
        result={{
          batchId: "b",
          succeeded: 1,
          failed: 1,
          rows: [
            {
              repositoryId: "101",
              fullName: "example-org/repo-a",
              change: "update",
              status: "succeeded",
            },
            {
              repositoryId: "102",
              fullName: "example-org/repo-b",
              change: "create",
              status: "failed",
              message: "Resource not accessible by integration",
            },
            {
              repositoryId: "103",
              fullName: "example-org/repo-c",
              change: "skipped",
              status: "skipped",
              reason: "archived",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("1 succeeded, 1 failed.");
    expect(html).toContain("Resource not accessible by integration");
    expect(html).toContain("The repository is archived.");
  });

  it("revert starts with a preview button", () => {
    expect(
      render(<RevertBatchForm installationId="42" batchId="b" />),
    ).toContain(">Preview revert</button>");
  });
});

describe("audit", () => {
  it("shows the app user, the role, the provider and the App identity", () => {
    const html = render(
      <AuditTable
        entries={[auditEntry()]}
        caption="Audit log"
        batchHref={(b) => `/o/example-org/variables/batches/${b}`}
        filterHref={() => "/o/example-org/audit"}
        canRevert
      />,
    );
    expect(html).toContain("Example User");
    expect(html).toContain("admin via oidc");
    expect(html).toContain("performed as app:example-app[bot]");
    expect(html).toContain(">Revert batch</a>");
  });

  it("has no revert link without the admin role", () => {
    const html = render(
      <AuditTable
        entries={[auditEntry()]}
        caption="Audit log"
        batchHref={(b) => `/o/example-org/variables/batches/${b}`}
        filterHref={() => "/o/example-org/audit"}
        canRevert={false}
      />,
    );
    expect(html).not.toContain("Revert batch");
  });

  it("states the verify result", () => {
    expect(
      render(
        <VerifyResult
          state={{ ok: true, checked: 12, unsealed: 0, firstBreak: null }}
        />,
      ),
    ).toContain("intact (12 entries checked)");
    const broken = render(
      <VerifyResult
        state={{
          ok: false,
          checked: 12,
          unsealed: 0,
          firstBreak: { seq: "7", id: "x", reason: "hash" },
        }}
      />,
    );
    expect(broken).toContain("broken at entry 7");
    expect(broken).toContain("content was changed");
  });
});

describe("settings and Dependabot", () => {
  it("toggles are hidden while the global kill switch is off", () => {
    const off = render(
      <ManagementSettings
        installationId="42"
        globalEnabled={false}
        managementEnabled={false}
        redactVariableValues={false}
      />,
    );
    expect(off).not.toContain("<button");
    expect(off).toContain("MANAGEMENT_ENABLED=false");
    const on = render(
      <ManagementSettings
        installationId="42"
        globalEnabled
        managementEnabled={false}
        redactVariableValues
      />,
    );
    expect(on).toContain(">Turn on</button>");
    expect(on).toContain(">Turn off</button>");
  });

  it("writes severity out and links the matching Dependabot PR", () => {
    const pr = pull({ title: "Bump example-lib from 1.2.2 to 1.2.3" });
    expect(matchingPull(alert(), [pr])).toBe(pr);
    expect(matchingPull(alert({ repositoryId: "999" }), [pr])).toBeNull();
    const html = render(
      <AlertsTable alerts={[alert()]} pulls={[pr]} caption="Alerts" />,
    );
    expect(html).toContain(">high<");
    expect(html).toContain("GHSA-xxxx-yyyy-zzzz");
    expect(html).toContain(
      'href="https://github.com/example-org/repo-a/pull/7"',
    );
    const matrix = render(
      <SeverityMatrix
        repos={[
          {
            repositoryId: "101",
            fullName: "example-org/repo-a",
            status: "disabled",
            counts: { critical: 0, high: 0, medium: 0, low: 0 },
          },
        ]}
        totals={{ critical: 0, high: 1, medium: 0, low: 0 }}
        caption="By repo"
      />,
    );
    expect(matrix).toContain("turned off for this repository");
  });

  it("renders in German", () => {
    const html = render(<RunActions installationId="42" run={run()} />, "de");
    expect(html).toContain("Alle Jobs neu starten");
  });
});
