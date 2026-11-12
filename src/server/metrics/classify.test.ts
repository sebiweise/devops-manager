import { describe, expect, it } from "vitest";
import { seedRatesAsRows } from "./sku-seed";
import {
  baseNameOf,
  classifyRunner,
  isSelfHostedKey,
  jobRunnerKeyResolver,
  labelKeyOf,
  runnerKeyOf,
  runnerOsOf,
  runnerStatKey,
  skuOf,
} from "./classify";
import { estimateJobCost, rateFor } from "./cost";

const rates = seedRatesAsRows();

describe("runner classification", () => {
  it.each([
    [["self-hosted", "linux", "x64"], null, null, "SELF_HOSTED"],
    [["linux"], "runner-1", "repo-runners", "SELF_HOSTED"],
    [["ubuntu-latest"], "GitHub Actions 12", "GitHub Actions", "GITHUB_HOSTED"],
    [["ubuntu-latest"], null, null, "GITHUB_HOSTED"],
    [["windows-2022"], null, null, "GITHUB_HOSTED"],
    [["macos-latest-xlarge"], null, null, "LARGER_HOSTED"],
    [
      ["ubuntu-latest-4-cores"],
      "GitHub Actions 3",
      "GitHub Actions",
      "LARGER_HOSTED",
    ],
    [["custom-pool"], "GitHub Actions 3", "GitHub Actions", "LARGER_HOSTED"],
    [["custom-pool"], null, null, "UNKNOWN"],
  ] as const)("%j on %s/%s is %s", (labels, name, group, kind) => {
    expect(
      classifyRunner(
        { labels: [...labels], runnerName: name, runnerGroupName: group },
        rates,
      ),
    ).toBe(kind);
  });

  it("derives the OS from labels, falling back to the runner", () => {
    expect(runnerOsOf(["ubuntu-24.04"])).toBe("LINUX");
    expect(runnerOsOf(["self-hosted", "Linux"])).toBe("LINUX");
    expect(runnerOsOf(["windows-latest"])).toBe("WINDOWS");
    expect(runnerOsOf(["macos-14"])).toBe("MACOS");
    expect(runnerOsOf(["self-hosted"], "macOS")).toBe("MACOS");
    expect(runnerOsOf(["self-hosted"])).toBe("UNKNOWN");
  });

  it("maps SKUs, and leaves unmatched larger runners without one", () => {
    expect(skuOf("GITHUB_HOSTED", "LINUX", ["ubuntu-latest"], rates)).toBe(
      "linux",
    );
    expect(skuOf("GITHUB_HOSTED", "MACOS", ["macos-latest"], rates)).toBe(
      "macos",
    );
    expect(
      skuOf("LARGER_HOSTED", "LINUX", ["ubuntu-latest-8-cores"], rates),
    ).toBe("linux_8_core");
    expect(
      skuOf("LARGER_HOSTED", "WINDOWS", ["windows-latest-8-cores"], rates),
    ).toBe("windows_8_core");
    expect(skuOf("LARGER_HOSTED", "LINUX", ["custom-pool"], rates)).toBeNull();
    expect(skuOf("SELF_HOSTED", "LINUX", ["self-hosted"], rates)).toBeNull();
  });

  it("normalises labels and strips matrix suffixes", () => {
    expect(labelKeyOf(["Linux", "self-hosted", "linux"])).toBe(
      "linux,self-hosted",
    );
    expect(baseNameOf("test (ubuntu-latest, 22)")).toBe("test");
    expect(baseNameOf("build")).toBe("build");
    expect(runnerKeyOf("SELF_HOSTED", "runner-1", "self-hosted")).toBe(
      "sh:runner-1",
    );
    expect(runnerKeyOf("GITHUB_HOSTED", null, "ubuntu-latest")).toBe(
      "pool:ubuntu-latest",
    );
  });
});

describe("runner keys", () => {
  // repo-a (11) and repo-b (12) each have a repo runner called runner-1;
  // runner-2 is an org runner.
  const runners = [
    { scope: "REPO" as const, repositoryId: 11n, name: "runner-1" },
    { scope: "REPO" as const, repositoryId: 12n, name: "runner-1" },
    { scope: "ORG" as const, repositoryId: null, name: "runner-2" },
  ];
  const keyOf = jobRunnerKeyResolver(runners);
  const job = (repositoryId: bigint, runnerName: string | null) => ({
    runnerKind: "SELF_HOSTED" as const,
    runnerName,
    labelKey: "self-hosted",
    repositoryId,
  });

  it("keys repo runners by repository and name, so equal names stay apart", () => {
    expect(runnerStatKey(runners[0]!)).toBe("shr:11:runner-1");
    expect(runnerStatKey(runners[1]!)).toBe("shr:12:runner-1");
    expect(runnerStatKey(runners[2]!)).toBe("sh:runner-2");
    expect(keyOf(job(11n, "runner-1"))).toBe("shr:11:runner-1");
    expect(keyOf(job(12n, "runner-1"))).toBe("shr:12:runner-1");
  });

  it("gives other self-hosted jobs to the org (or unknown) runner of that name", () => {
    expect(keyOf(job(11n, "runner-2"))).toBe("sh:runner-2");
    expect(keyOf(job(13n, "runner-1"))).toBe("sh:runner-1");
    expect(
      keyOf({
        runnerKind: "GITHUB_HOSTED",
        runnerName: "GitHub Actions 2",
        labelKey: "ubuntu-latest",
        repositoryId: 11n,
      }),
    ).toBe("pool:ubuntu-latest");
    expect(isSelfHostedKey("shr:11:runner-1")).toBe(true);
    expect(isSelfHostedKey("sh:runner-2")).toBe(true);
    expect(isSelfHostedKey("pool:ubuntu-latest")).toBe(false);
  });
});

describe("cost estimate", () => {
  const day = new Date("2026-11-02T00:00:00Z");

  it("rounds each job up to whole minutes and applies the multiplier", () => {
    expect(
      estimateJobCost(
        {
          kind: "GITHUB_HOSTED",
          sku: "macos",
          durationS: 61,
          repoPrivate: true,
          day,
        },
        rates,
      ),
    ).toEqual({ rawMin: 2, billableMinEst: 20, estUsd: 0.16 });
    expect(
      estimateJobCost(
        {
          kind: "GITHUB_HOSTED",
          sku: "windows",
          durationS: 600,
          repoPrivate: true,
          day,
        },
        rates,
      )?.billableMinEst,
    ).toBe(20);
  });

  it("is zero for self-hosted, unknown and public standard hosted jobs", () => {
    for (const input of [
      { kind: "SELF_HOSTED" as const, sku: null, repoPrivate: true },
      { kind: "UNKNOWN" as const, sku: null, repoPrivate: true },
      { kind: "GITHUB_HOSTED" as const, sku: "linux", repoPrivate: false },
      { kind: "LARGER_HOSTED" as const, sku: null, repoPrivate: true },
    ]) {
      expect(
        estimateJobCost({ ...input, durationS: 300, day }, rates)
          ?.billableMinEst,
      ).toBe(0);
    }
  });

  it("charges larger runners in public repositories", () => {
    expect(
      estimateJobCost(
        {
          kind: "LARGER_HOSTED",
          sku: "linux_4_core",
          durationS: 120,
          repoPrivate: false,
          day,
        },
        rates,
      )?.billableMinEst,
    ).toBe(4);
  });

  it("is null while the job has no duration", () => {
    expect(
      estimateJobCost(
        {
          kind: "GITHUB_HOSTED",
          sku: "linux",
          durationS: null,
          repoPrivate: true,
          day,
        },
        rates,
      ),
    ).toBeNull();
  });

  it("uses the latest rate effective on the day", () => {
    const history = [
      {
        ...rates[0]!,
        minuteMultiplier: 1,
        effectiveFrom: new Date("2024-01-01T00:00:00Z"),
      },
      {
        ...rates[0]!,
        minuteMultiplier: 3,
        effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      },
    ];
    expect(
      rateFor(history, "linux", new Date("2026-05-31T00:00:00Z"))
        ?.minuteMultiplier,
    ).toBe(1);
    expect(rateFor(history, "linux", day)?.minuteMultiplier).toBe(3);
    expect(
      rateFor(history, "linux", new Date("2023-01-01T00:00:00Z")),
    ).toBeNull();
  });
});
