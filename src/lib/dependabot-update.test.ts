import { describe, expect, it } from "vitest";
import {
  dependabotUpdateType,
  isPatchOrMinor,
  updateTypeFromCommit,
  updateTypeFromTitle,
} from "./dependabot-update";

const metadata = (...types: string[]) =>
  [
    "Bump the npm group with 2 updates",
    "",
    "---",
    "updated-dependencies:",
    ...types.flatMap((t, i) => [
      `- dependency-name: example-lib-${i}`,
      "  dependency-type: direct:production",
      `  update-type: ${t}`,
    ]),
    "...",
    "",
    "Signed-off-by: dependabot[bot] <support@example.com>",
  ].join("\n");

describe("Dependabot update type", () => {
  it("reads the largest update type from the commit metadata", () => {
    expect(updateTypeFromCommit(metadata("version-update:semver-patch"))).toBe(
      "patch",
    );
    expect(
      updateTypeFromCommit(
        metadata("version-update:semver-patch", "version-update:semver-minor"),
      ),
    ).toBe("minor");
    expect(
      updateTypeFromCommit(
        metadata("version-update:semver-minor", "version-update:semver-major"),
      ),
    ).toBe("major");
    expect(updateTypeFromCommit(metadata("something-else"))).toBe("major");
    expect(updateTypeFromCommit("Fix a typo")).toBeNull();
  });

  it("falls back to the versions in the title", () => {
    expect(updateTypeFromTitle("Bump example-lib from 1.2.3 to 1.2.4")).toBe(
      "patch",
    );
    expect(updateTypeFromTitle("Bump example-lib from 1.2.3 to 1.3.0")).toBe(
      "minor",
    );
    expect(updateTypeFromTitle("Bump actions/checkout from 4 to 5")).toBe(
      "major",
    );
    expect(
      updateTypeFromTitle(
        "chore(deps): bump example-lib from v2.1.0 to v2.1.1",
      ),
    ).toBe("patch");
    expect(updateTypeFromTitle("Bump the npm group with 3 updates")).toBeNull();
  });

  it("prefers the commit metadata and only lets patch and minor through", () => {
    expect(
      dependabotUpdateType("Bump the npm group with 2 updates", [
        metadata("version-update:semver-minor"),
      ]),
    ).toBe("minor");
    expect(
      dependabotUpdateType("Bump example-lib from 1.0.0 to 1.0.1", [
        metadata("version-update:semver-major"),
      ]),
    ).toBe("major");
    expect(isPatchOrMinor("patch")).toBe(true);
    expect(isPatchOrMinor("minor")).toBe(true);
    expect(isPatchOrMinor("major")).toBe(false);
    expect(isPatchOrMinor(null)).toBe(false);
  });
});
