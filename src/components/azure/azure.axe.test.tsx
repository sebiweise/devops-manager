// @vitest-environment jsdom
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/o/example-org/pipelines",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/server/actions/azure", () => ({
  connectAzureAction: vi.fn(),
  rotateAzureAction: vi.fn(),
  disconnectAzureAction: vi.fn(),
  selectAzureProjectsAction: vi.fn(),
  linkAzureDefinitionAction: vi.fn(),
  setAzureDefinitionOsServerAction: vi.fn(),
  updateAzureLimitsAction: vi.fn(),
  installAzureHooksAction: vi.fn(),
  rotateAzureHookSecretAction: vi.fn(),
  setAzureManagementAction: vi.fn(),
  queueAzureRunAction: vi.fn(),
  azureBuildAction: vi.fn(),
  azureLogAction: vi.fn(),
}));

const badges = await import("./azure-badges");
const actions = await import("./azure-actions");
const settings = await import("./azure-settings");

const ctx = {
  installationId: "2002",
  minutesLeft: 20,
  maxJobMinutes: 60,
  running: 1,
  limit: 1,
  blockWhenQuotaExhausted: true,
};
const controls = { close: () => undefined, changed: () => undefined };
const build = {
  id: 4100,
  buildNumber: "20261113.4",
  definitionName: "ci-linux",
  status: "COMPLETED",
  result: "FAILED",
  p90Minutes: 30,
};
const definition = {
  projectId: "00000000-0000-4000-8000-000000000011",
  id: 11,
  name: "ci-linux",
  defaultBranch: "main",
  p90Minutes: 30,
};

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? en : de}
      timeZone="UTC"
      now={new Date("2026-11-13T12:00:00Z")}
    >
      <main>
        <h1>Azure Pipelines</h1>
        {node}
      </main>
    </NextIntlClientProvider>,
  );
}

async function violations(html: string) {
  document.documentElement.lang = "en";
  document.title = "Azure Pipelines";
  document.body.innerHTML = html;
  const result = await axe.run(document.body, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

const blocks: Array<[string, React.ReactNode]> = [
  [
    "source badges",
    <p key="s">
      <badges.SourceBadge provider="github" />{" "}
      <badges.SourceBadge provider="azure" />
    </p>,
  ],
  [
    "build badges",
    <p key="b">
      <badges.AzureBuildBadge status="COMPLETED" result="PARTIALLY_SUCCEEDED" />{" "}
      <badges.AzureBuildBadge status="IN_PROGRESS" result="NONE" />
    </p>,
  ],
  [
    "PR badge",
    <badges.PrAzureBadge
      key="pr"
      builds={[
        {
          id: 1,
          definitionName: "ci-linux",
          status: "COMPLETED",
          result: "FAILED",
          timedOut: false,
          href: "/o/example-org/pipelines/runs/1",
        },
      ]}
    />,
  ],
  [
    "queue form",
    <actions.QueueForm
      key="q"
      ctx={ctx}
      definition={definition}
      controls={controls}
    />,
  ],
  [
    "retry form",
    <actions.BuildForm
      key="r"
      ctx={ctx}
      build={build}
      operation="retry"
      controls={controls}
    />,
  ],
  [
    "stage retry form",
    <actions.BuildForm
      key="sr"
      ctx={ctx}
      build={build}
      operation="retryStage"
      stage={{ identifier: "Build", name: "Build" }}
      controls={controls}
    />,
  ],
  ["build actions", <actions.BuildActions key="ba" ctx={ctx} build={build} />],
  [
    "log excerpt",
    <actions.AzureLogExcerpt
      key="l"
      installationId="2002"
      buildId={4100}
      recordId="00000000-0000-4000-9000-000000000001"
      attempt={1}
    />,
  ],
  [
    "toggle form",
    <actions.ToggleForm
      key="t"
      installationId="2002"
      orgName="contoso-ci"
      enabled={false}
      controls={controls}
    />,
  ],
  [
    "connect form",
    <settings.CredentialForm
      key="c"
      installationId="2002"
      mode="connect"
      controls={controls}
    />,
  ],
  [
    "rotate form",
    <settings.CredentialForm
      key="ro"
      installationId="2002"
      mode="rotate"
      orgName="contoso-ci"
      currentKind="ENTRA_SP"
      controls={controls}
    />,
  ],
  [
    "disconnect form",
    <settings.DisconnectForm
      key="d"
      installationId="2002"
      orgName="contoso-ci"
      hasHooks
      controls={controls}
    />,
  ],
  [
    "projects form",
    <settings.ProjectsForm
      key="p"
      installationId="2002"
      projects={[
        {
          id: "00000000-0000-4000-8000-000000000011",
          name: "project-a",
          visibility: "private",
          selected: true,
        },
      ]}
      controls={controls}
    />,
  ],
  [
    "definition form",
    <settings.DefinitionForm
      key="df"
      installationId="2002"
      definition={{
        projectId: "00000000-0000-4000-8000-000000000011",
        id: 11,
        name: "ci-linux",
        manualRepositoryId: null,
        osOverride: null,
      }}
      repositories={[{ id: "201", fullName: "example-org/repo-a" }]}
      controls={controls}
    />,
  ],
  [
    "limits form",
    <settings.LimitsForm
      key="lf"
      installationId="2002"
      limits={{
        hostedParallelJobs: 1,
        includedMinutes: 1800,
        maxJobMinutes: 60,
        monthResetDay: 1,
        blockWhenQuotaExhausted: false,
      }}
      detected={{ totalMinutes: 1800, totalCount: 1, isPremium: false }}
      controls={controls}
    />,
  ],
  [
    "hook form",
    <settings.HookForm
      key="h"
      installationId="2002"
      op="auto"
      controls={controls}
    />,
  ],
];

describe("Azure Pipelines components (axe)", () => {
  for (const [name, node] of blocks) {
    it(`${name}: no serious violations (en, de)`, async () => {
      expect(await violations(render(node))).toEqual([]);
      const html = render(node, "de");
      expect(html).not.toMatch(/ci\.azure\.|ci\.source/);
      expect(await violations(html)).toEqual([]);
    });
  }

  it("names the source and the quota block", () => {
    const html = render(
      <>
        {blocks[0]![1]}
        {blocks[3]![1]}
      </>,
    );
    expect(html).toContain('aria-label="Source: Azure Pipelines"');
    expect(html).toContain("an admin turned on blocking");
    expect(html).toMatch(/disabled=""[^>]*>Queue run/);
  });
});
