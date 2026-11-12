// @vitest-environment jsdom
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";

vi.mock("@/server/actions/personal-billing", () => ({
  storeBillingTokenAction: vi.fn(),
  startGitHubConnectAction: vi.fn(),
  revokeBillingCredentialAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { ConnectButton, RevokeForm, StoreTokenForm } =
  await import("./billing-credential-forms");

/** The /admin/github forms pass axe (labels, names, live regions). */
describe("billing credential forms pass axe", () => {
  it("store, connect and revoke", async () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <main>
          <h1>GitHub billing credentials</h1>
          <StoreTokenForm installationId="42" account="example-user" />
          <ConnectButton installationId="42" reconnect={false} />
          <RevokeForm installationId="42" account="example-user" />
        </main>
      </NextIntlClientProvider>,
    );
    document.documentElement.lang = "en";
    document.title = "GitHub billing";
    document.body.innerHTML = html;
    const result = await axe.run(document.body, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });
    const bad = result.violations
      .filter((v) => v.impact === "critical" || v.impact === "serious")
      .map((v) => v.id);
    expect(bad).toEqual([]);
  });
});
