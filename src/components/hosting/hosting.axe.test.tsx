// @vitest-environment jsdom
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/o/example-org/deployments",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/server/actions/vercel", () => ({
  connectVercelAction: vi.fn(),
  rotateVercelTokenAction: vi.fn(),
  disconnectVercelAction: vi.fn(),
  linkVercelProjectAction: vi.fn(),
  vercelDeploymentAction: vi.fn(),
  setVercelManagementAction: vi.fn(),
  vercelBuildLogAction: vi.fn(),
}));

const { PreviewBadge } = await import("./preview-badge");
const { VercelTokenButton, VercelDisconnectButton, VercelLinkButton } =
  await import("./vercel-settings");
const { StatusBadge } = await import("../data/status-badge");
const {
  BuildLogExcerpt,
  DeploymentActions,
  OperationForm,
  VercelManagementToggle,
} = await import("./deployment-actions");

const ctx = { installationId: "2002", plan: "hobby", last24h: 12 };
const prodDeployment = {
  id: "dpl_demoP2",
  projectName: "project-a",
  target: "production",
  state: "READY",
  live: false,
  rollbackCandidate: true,
  commitSha: "a".repeat(40),
  branch: "main",
};
const controls = { close: () => undefined, changed: () => undefined };

/** The client-renderable hosting blocks with axe-core, in English and German. */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? en : de}
      timeZone="UTC"
      now={new Date("2026-11-12T12:00:00Z")}
    >
      <main>
        <h1>Hosting</h1>
        {node}
      </main>
    </NextIntlClientProvider>,
  );
}

async function violations(html: string) {
  document.documentElement.lang = "en";
  document.title = "Hosting";
  document.body.innerHTML = html;
  const result = await axe.run(document.body, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

const deployment = {
  target: "preview",
  state: "READY",
  url: "project-a-abc.vercel.app",
  projectName: "project-a",
  vercelUrl: "https://vercel.com/example-team/project-a/abc",
};

describe("hosting blocks", () => {
  for (const locale of ["en", "de"] as const) {
    it(`preview badge, state badges and settings controls (${locale})`, async () => {
      const html = render(
        <>
          <PreviewBadge deployments={[deployment]} />
          <PreviewBadge
            deployments={[
              {
                ...deployment,
                target: "production",
                state: "ERROR",
                url: null,
              },
            ]}
          />
          {(
            [
              "deployReady",
              "deployError",
              "deployBuilding",
              "deployQueued",
              "deployCanceled",
              "deployBlocked",
              "deployUnknown",
              "production",
              "preview",
              "manualLink",
              "autoAssignPaused",
            ] as const
          ).map((k) => (
            <StatusBadge key={k} kind={k} />
          ))}
          <VercelTokenButton installationId="2002" mode="connect" />
          <VercelTokenButton installationId="2002" mode="rotate" />
          <VercelDisconnectButton
            installationId="2002"
            teamSlug="example-team"
            envManaged={false}
          />
          <VercelLinkButton
            installationId="2002"
            project={{
              id: "prj_demo1",
              name: "project-c",
              manualRepositoryId: null,
            }}
            repositories={[{ id: "203", fullName: "example-org/repo-c" }]}
          />
        </>,
        locale,
      );
      expect(await violations(html)).toEqual([]);
      if (locale === "en") {
        expect(html).toContain('href="https://project-a-abc.vercel.app"');
        expect(html).toContain('rel="noopener noreferrer"');
        // Not ready: the badge links to Vercel, not to a hostname.
        expect(html).toContain("https://vercel.com/example-team/project-a/abc");
        expect(html).toContain("Deployed as preview: Ready");
        expect(html).toContain("Connect Vercel");
      }
    });
  }

  for (const locale of ["en", "de"] as const) {
    it(`M6 deployment actions, dialogs, build log and toggle (${locale})`, async () => {
      const html = render(
        <>
          <DeploymentActions ctx={ctx} deployment={prodDeployment} />
          <DeploymentActions
            ctx={ctx}
            deployment={{
              ...prodDeployment,
              id: "dpl_demoB1",
              target: "preview",
              state: "BUILDING",
              rollbackCandidate: false,
            }}
            compact
          />
          {(["redeploy", "cancel", "promote", "rollback"] as const).map(
            (op) => (
              <OperationForm
                key={op}
                ctx={ctx}
                deployment={prodDeployment}
                operation={op}
                controls={controls}
              />
            ),
          )}
          <BuildLogExcerpt installationId="2002" deploymentId="dpl_demoE1" />
          <VercelManagementToggle
            installationId="2002"
            teamSlug="example-team"
            enabled={false}
          />
        </>,
        locale,
      );
      expect(await violations(html)).toEqual([]);
      if (locale === "en") {
        // READY production, not live, a candidate: redeploy, promote, rollback.
        expect(html).toContain(">Redeploy<");
        expect(html).toContain(">Promote<");
        expect(html).toContain(">Roll back<");
        // Building: cancel only.
        expect(html).toContain(">Cancel<");
        expect(html).toContain("Type project-a to confirm");
        expect(html).toContain("12 of 100 deployments");
        expect(html).toContain("Show build log");
        expect(html).toContain("Turn on Vercel actions");
      }
    });
  }
});
