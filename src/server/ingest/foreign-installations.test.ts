import { describe, expect, it } from "vitest";
import {
  forgetForeignInstallation,
  isKnownForeignInstallation,
  namesForeignOwner,
  payloadOwnerLogins,
  rememberForeignInstallation,
} from "./foreign-installations";

const allowed = (login: string) => login.toLowerCase() === "acme";

describe("foreign installation guard", () => {
  it("reads the repository owner and organization from the payload", () => {
    expect(
      payloadOwnerLogins({
        repository: {
          id: 1,
          name: "r",
          full_name: "acme/r",
          private: false,
          owner: { login: "acme" },
        },
        organization: { login: "acme" },
      }),
    ).toEqual(["acme", "acme"]);
    expect(payloadOwnerLogins({})).toEqual([]);
  });

  it("flags payloads that name an owner outside the allowlist", () => {
    expect(
      namesForeignOwner({ organization: { login: "outsider" } }, allowed),
    ).toBe(true);
    expect(
      namesForeignOwner({ organization: { login: "ACME" } }, allowed),
    ).toBe(false);
    // Nothing named: the GitHub lookup decides.
    expect(namesForeignOwner({}, allowed)).toBe(false);
  });

  it("remembers rejected installation ids until forgotten", () => {
    expect(isKnownForeignInstallation(42n)).toBe(false);
    rememberForeignInstallation(42n);
    expect(isKnownForeignInstallation(42n)).toBe(true);
    forgetForeignInstallation(42n);
    expect(isKnownForeignInstallation(42n)).toBe(false);
  });
});
