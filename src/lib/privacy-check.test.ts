import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * scripts/check-personal-data.mjs (design addendum M7 §8 "Public repo"):
 * it must catch an Azure DevOps PAT in the 84-character AZDO format, a
 * dev.azure.com URL of a non-placeholder organisation and a term from the
 * env-provided deny list, and accept the placeholders. The planted values
 * are built at runtime in a throwaway git repository, so they never exist
 * in this repository.
 */

const script = fileURLToPath(
  new URL("../../scripts/check-personal-data.mjs", import.meta.url),
);
const dirs: string[] = [];

function check(files: Record<string, string>, denylist = "") {
  const dir = mkdtempSync(join(tmpdir(), "privacy-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  execFileSync("git", ["add", "."], { cwd: dir });
  const r = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PRIVACY_DENYLIST: denylist },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("privacy check: Azure DevOps rules", () => {
  it("catches an 84-character AZDO PAT", () => {
    const pat = ["Q".repeat(40), "w".repeat(36), "AZDO", "r9k2"].join("");
    const r = check({ "a.ts": `const pat = "${pat}";\n` });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Azure DevOps personal access token/);
  });

  it("catches a legacy 52-character PAT next to the word PAT", () => {
    const legacy = "abcdefghijklmnopqrstuvwxyz234567".repeat(2).slice(0, 52);
    const r = check({ "a.md": `AZURE_DEVOPS_PAT=${legacy}\n` });
    expect(r.code).toBe(1);
  });

  it("catches a dev.azure.com URL of a real-looking organisation", () => {
    const org = ["acme", "corp", "ci"].join("");
    const r = check({ "a.md": `see https://dev.azure.com/${org}/project\n` });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/organisation URL/);
  });

  it("catches a term of the env deny list", () => {
    const term = ["secret", "team", "name"].join("-");
    const r = check({ "a.md": `pipeline of ${term}\n` }, term);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/denylisted term/);
  });

  it("accepts placeholders", () => {
    const r = check({
      "a.md": [
        "https://dev.azure.com/contoso-ci/_build",
        "https://dev.azure.com/fabrikam/_apis/projects",
        "https://dev.azure.com/{organization}/_apis/build/builds",
        "https://dev.azure.com/example-org",
        'const pat = "test-pat-not-real-0001";',
      ].join("\n"),
    });
    expect(r.out).toMatch(/passed/);
    expect(r.code).toBe(0);
  });
});
