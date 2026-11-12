import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";

// The Server Actions and the router are not needed to render the forms.
vi.mock("@/server/actions/personal-billing", () => ({
  storeBillingTokenAction: vi.fn(),
  startGitHubConnectAction: vi.fn(),
  revokeBillingCredentialAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const { ConnectButton, isAuthorizeUrl, RevokeForm, StoreTokenForm } =
  await import("./billing-credential-forms");

/**
 * /admin/github forms (design §3.4): the token field is a password field
 * without autocomplete and starts empty, Store and Remove need the typed
 * account login, and only GitHub's authorize URL is followed.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("StoreTokenForm", () => {
  const html = render(
    <StoreTokenForm installationId="42" account="example-user" />,
  );

  it("uses an empty password field without autocomplete", () => {
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="off"/);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*value=""/);
  });

  it("labels both fields and asks for the account login", () => {
    expect(html).toMatch(/<label for="[^"]+-token"[^>]*>Token<\/label>/);
    expect(html).toContain("Type example-user to confirm");
  });

  it("keeps submit disabled until the login is typed", () => {
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain(">Store token</button>");
    expect(html).toContain('role="status"');
  });
});

describe("RevokeForm and ConnectButton", () => {
  it("revoke needs the typed confirmation", () => {
    const html = render(
      <RevokeForm installationId="42" account="example-user" />,
    );
    expect(html).toContain("Type example-user to confirm");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Remove credential<\/button>/,
    );
  });

  it("connect says reconnect for a revoked credential", () => {
    expect(
      render(<ConnectButton installationId="42" reconnect={false} />),
    ).toContain(">Connect GitHub</button>");
    expect(render(<ConnectButton installationId="42" reconnect />)).toContain(
      ">Reconnect GitHub</button>",
    );
  });
});

describe("isAuthorizeUrl", () => {
  it("accepts only https://github.com/login/oauth/authorize", () => {
    expect(
      isAuthorizeUrl(
        "https://github.com/login/oauth/authorize?client_id=Iv1.example&state=x",
      ),
    ).toBe(true);
    expect(isAuthorizeUrl("http://github.com/login/oauth/authorize")).toBe(
      false,
    );
    expect(
      isAuthorizeUrl("https://github.com.example.com/login/oauth/authorize"),
    ).toBe(false);
    expect(isAuthorizeUrl("https://example.com/login/oauth/authorize")).toBe(
      false,
    );
    expect(isAuthorizeUrl("javascript:alert(1)")).toBe(false);
    expect(isAuthorizeUrl(undefined)).toBe(false);
  });
});
