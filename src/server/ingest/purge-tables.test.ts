import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {} }));

/**
 * Completeness of the purge lists (design addendum M7 §2.2): every model
 * with an installationId is deleted by the installation purge and reset by
 * the integration tests; every Azure DevOps model is deleted by the
 * disconnect. A new table that is missing from a list fails here.
 */

const schema = readFileSync(
  new URL("../../../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
  .filter(([, , body]) => /^\s+installationId\s/m.test(body!))
  .map(([, name]) => name!);

describe("purge lists", () => {
  it("finds the tenant models", () => {
    expect(models).toContain("AzureBuild");
    expect(models).toContain("WorkflowRun");
  });

  it("the installation purge covers every tenant model", async () => {
    const { PURGE_TABLES } = await import("./prune");
    // AuditLog and AuditChainHead stay by design (append-only, hash-chained).
    const expected = models.filter(
      (m) => !["AuditLog", "AuditChainHead"].includes(m),
    );
    expect(
      expected.filter((m) => !(PURGE_TABLES as readonly string[]).includes(m)),
    ).toEqual([]);
  });

  it("the integration tests reset every tenant model", () => {
    const support = readFileSync(
      new URL("../../../test/integration/support/actions.ts", import.meta.url),
      "utf8",
    );
    const truncate = support.slice(
      support.indexOf("TRUNCATE"),
      support.indexOf("CASCADE"),
    );
    expect(models.filter((m) => !truncate.includes(`"${m}"`))).toEqual([]);
  });

  it("the Azure disconnect purges every Azure DevOps model", async () => {
    const { AZURE_TABLES } = await import("@/server/data/azure");
    const azure = models.filter((m) =>
      /^(Azure|Pipeline|DailyPipeline|DailyAzure)/.test(m),
    );
    expect(
      azure.filter((m) => !(AZURE_TABLES as readonly string[]).includes(m)),
    ).toEqual([]);
  });
});
