// @vitest-environment jsdom
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

let pathname = "/o/example-org/runs/42";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams("range=30d&page=2&before=x"),
}));
vi.mock("@/i18n/actions", () => ({ setLocale: vi.fn(), setTheme: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));

const { AccountNav, isActive } = await import("../insights/account-nav");
const { AccountSwitcher, accountOfPath } = await import("./account-switcher");
const { UserMenu, AdminMenu } = await import("./user-menu");
const { RangeControl, usesRange } = await import("./range-control");

/**
 * The app shell (UI overhaul §1.1, §1.2): grouped account navigation with
 * active prefixes, the account switcher, the user and Admin menus and the
 * shared range control; axe-core over each in English and German.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? en : de}
      timeZone="UTC"
    >
      <main>
        <h1>Shell</h1>
        {node}
      </main>
    </NextIntlClientProvider>,
  );
}

async function violations(html: string) {
  document.documentElement.lang = "en";
  document.title = "Shell";
  document.body.innerHTML = html;
  const result = await axe.run(document.body, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

const base = "/o/example-org";
const groups = [
  {
    label: "Insights",
    items: [
      { href: base, label: "Overview", exact: true },
      {
        href: `${base}/repos`,
        label: "Repositories",
        activePrefixes: [`${base}/runs`],
      },
      { href: `${base}/runners`, label: "Runners" },
    ],
  },
  { label: "Audit", items: [{ href: `${base}/audit`, label: "Audit log" }] },
];

describe("AccountNav", () => {
  it("marks Repositories on a run page through its active prefix", () => {
    pathname = `${base}/runs/42`;
    const html = render(
      <AccountNav label="Account sections" groups={groups} />,
    );
    expect(html).toMatch(/aria-current="page"[^>]*>Repositories</);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("keeps the overview exact", () => {
    expect(isActive(`${base}/repos`, groups[0]!.items[0]!)).toBe(false);
    expect(isActive(base, groups[0]!.items[0]!)).toBe(true);
    expect(isActive(`${base}/runners/x`, groups[0]!.items[2]!)).toBe(true);
    expect(isActive(`${base}/runnersx`, groups[0]!.items[2]!)).toBe(false);
  });

  it("has no serious axe violations", async () => {
    expect(
      await violations(
        render(<AccountNav label="Account sections" groups={groups} />),
      ),
    ).toEqual([]);
  });
});

describe("AccountSwitcher and menus", () => {
  const accounts = [
    { login: "example-org", type: "ORGANIZATION" as const },
    { login: "example-user", type: "USER" as const },
  ];

  it("names the current account and lists all accounts first", () => {
    pathname = `${base}/repos`;
    const html = render(<AccountSwitcher accounts={accounts} />);
    expect(html).toContain("Switch account, current: example-org");
    expect(html.indexOf("All accounts")).toBeLessThan(
      html.indexOf("/o/example-user"),
    );
    expect(accountOfPath("/o/example-user/costs")).toBe("example-user");
    expect(accountOfPath("/dashboard")).toBeNull();
  });

  it("renders the menus accessibly in both languages", async () => {
    for (const locale of ["en", "de"] as const) {
      const html = render(
        <>
          <AccountSwitcher accounts={accounts} />
          <AdminMenu
            items={[{ href: "/onboarding", label: "Installations" }]}
          />
          <UserMenu email="admin@example.com" role="Admin" theme="dark" />
        </>,
        locale,
      );
      expect(await violations(html)).toEqual([]);
    }
    const de_ = render(
      <UserMenu email="admin@example.com" role="Admin" theme="dark" />,
      "de",
    );
    expect(de_).toContain("Darstellung");
    expect(de_).toContain("Dunkel");
  });
});

describe("RangeControl", () => {
  it("shows only on pages that follow the range", () => {
    expect(usesRange(base, base)).toBe(true);
    expect(usesRange(`${base}/workflows`, base)).toBe(true);
    expect(usesRange(`${base}/runners/r-1`, base)).toBe(true);
    expect(usesRange(`${base}/queue`, base)).toBe(false);
    expect(usesRange(`${base}/costs`, base)).toBe(false);
  });

  it("links keep other params but reset paging and the cursor", async () => {
    pathname = `${base}/repos`;
    const html = render(<RangeControl accountBase={base} cookieRange={null} />);
    expect(html).toContain(`href="${base}/repos?range=90d"`);
    expect(html).not.toContain("before=");
    expect(html).toMatch(/aria-current="true"[^>]*>30 d/);
    expect(await violations(html)).toEqual([]);
  });

  it("renders nothing on the queue", () => {
    pathname = `${base}/queue`;
    expect(
      render(<RangeControl accountBase={base} cookieRange="30d" />),
    ).not.toContain('role="group"');
  });
});
