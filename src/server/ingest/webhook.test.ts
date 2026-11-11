import { describe, expect, it, vi } from "vitest";
import { signPayload } from "./verify";
import {
  handleWebhook,
  MAX_BODY_BYTES,
  redactError,
  type DeliveryOutcome,
  type DeliveryRow,
  type TenantCheck,
  type WebhookStore,
} from "./webhook";

const SECRET = "test-webhook-secret";
const PREVIOUS = "previous-webhook-secret";

function memoryStore(overrides: Partial<WebhookStore> = {}) {
  const rows = new Map<string, DeliveryRow & { final?: DeliveryOutcome }>();
  const store: WebhookStore & { rows: typeof rows } = {
    rows,
    insertDelivery: vi.fn(async (row: DeliveryRow) => {
      if (rows.has(row.id)) return "duplicate" as const;
      rows.set(row.id, { ...row });
      return "inserted" as const;
    }),
    claimDelivery: vi.fn(async () => true),
    finishDelivery: vi.fn(async (id: string, outcome: DeliveryOutcome) => {
      const row = rows.get(id);
      if (row) {
        row.final = outcome;
        if (outcome.status !== "FAILED") row.payload = null;
      }
    }),
    checkTenant: vi.fn(async (_e, payload): Promise<TenantCheck> => ({
      ok: true,
      installationId:
        payload.installation?.id != null
          ? BigInt(payload.installation.id)
          : null,
    })),
    fold: vi.fn(async () => undefined),
    touched: vi.fn(async () => undefined),
    onSignatureFailure: vi.fn(),
    ...overrides,
  };
  return store;
}

function request(
  event: string,
  payload: unknown,
  opts: { id?: string; secret?: string; signature?: string } = {},
) {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": opts.id ?? "delivery-1",
    "x-hub-signature-256":
      opts.signature ?? signPayload(opts.secret ?? SECRET, body),
  });
  return { headers, body };
}

const installationCreated = {
  action: "created",
  installation: {
    id: 1001,
    account: { id: 1, login: "example-org", type: "Organization" },
    repository_selection: "all",
    permissions: { metadata: "read" },
    events: [],
  },
  repositories: [
    { id: 10, name: "repo-a", full_name: "example-org/repo-a", private: false },
  ],
};

describe("handleWebhook", () => {
  it("processes an installation event and nulls the payload", async () => {
    const store = memoryStore();
    const res = await handleWebhook(
      request("installation", installationCreated),
      [SECRET],
      store,
    );
    expect(res.status).toBe(202);
    expect(res.body.result).toBe("processed");
    expect(store.fold).toHaveBeenCalledWith(
      "installation",
      expect.anything(),
      1001n,
    );
    expect(store.rows.get("delivery-1")?.final).toEqual({
      status: "PROCESSED",
    });
    expect(store.rows.get("delivery-1")?.payload).toBeNull();
    expect(store.touched).toHaveBeenCalledWith(1001n);
  });

  it("returns 401 for a bad signature and stores nothing", async () => {
    const store = memoryStore();
    const res = await handleWebhook(
      request("installation", installationCreated, { secret: "wrong" }),
      [SECRET],
      store,
    );
    expect(res.status).toBe(401);
    expect(store.insertDelivery).not.toHaveBeenCalled();
    expect(store.fold).not.toHaveBeenCalled();
    expect(store.onSignatureFailure).toHaveBeenCalledOnce();
    expect(store.rows.size).toBe(0);
  });

  it("returns 401 when a required header is missing", async () => {
    for (const header of [
      "x-github-event",
      "x-github-delivery",
      "x-hub-signature-256",
    ]) {
      const store = memoryStore();
      const req = request("installation", installationCreated);
      req.headers.delete(header);
      const res = await handleWebhook(req, [SECRET], store);
      expect(res.status).toBe(401);
      expect(store.insertDelivery).not.toHaveBeenCalled();
    }
  });

  it("accepts the previous secret during rotation", async () => {
    const store = memoryStore();
    const res = await handleWebhook(
      request("installation", installationCreated, { secret: PREVIOUS }),
      [SECRET, PREVIOUS],
      store,
    );
    expect(res.status).toBe(202);
  });

  it("dedupes a redelivery with the same delivery id", async () => {
    const store = memoryStore();
    await handleWebhook(
      request("installation", installationCreated),
      [SECRET],
      store,
    );
    const res = await handleWebhook(
      request("installation", installationCreated),
      [SECRET],
      store,
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("duplicate");
    expect(store.fold).toHaveBeenCalledOnce();
  });

  it("returns 503 when the database is unreachable", async () => {
    const store = memoryStore({
      insertDelivery: vi.fn(async () => {
        throw new Error("timeout exceeded when trying to connect");
      }),
    });
    const res = await handleWebhook(
      request("installation", installationCreated),
      [SECRET],
      store,
    );
    expect(res.status).toBe(503);
    expect(store.fold).not.toHaveBeenCalled();
  });

  it("records unknown events as SKIPPED without payload", async () => {
    const store = memoryStore();
    const res = await handleWebhook(
      request("push", { ref: "refs/heads/main" }),
      [SECRET],
      store,
    );
    expect(res.status).toBe(202);
    const row = store.rows.get("delivery-1");
    expect(row?.status).toBe("SKIPPED");
    expect(row?.payload).toBeNull();
    expect(store.fold).not.toHaveBeenCalled();
  });

  it("skips installations of accounts that are not allowed", async () => {
    const store = memoryStore({
      checkTenant: vi.fn(async (): Promise<TenantCheck> => ({
        ok: false,
        status: "SKIPPED",
        reason: "account not in ALLOWED_ACCOUNTS",
      })),
    });
    const res = await handleWebhook(
      request("installation", installationCreated),
      [SECRET],
      store,
    );
    expect(res.status).toBe(202);
    expect(store.fold).not.toHaveBeenCalled();
    expect(store.rows.get("delivery-1")?.final?.status).toBe("SKIPPED");
    expect(store.rows.get("delivery-1")?.payload).toBeNull();
  });

  it("rejects a repository that belongs to another installation", async () => {
    const store = memoryStore({
      checkTenant: vi.fn(async (): Promise<TenantCheck> => ({
        ok: false,
        status: "REJECTED",
        reason: "repository belongs to another installation",
      })),
    });
    const res = await handleWebhook(
      request("repository", {
        action: "renamed",
        installation: { id: 1 },
        repository: { id: 5 },
      }),
      [SECRET],
      store,
    );
    expect(res.body.result).toBe("rejected");
    expect(store.fold).not.toHaveBeenCalled();
  });

  it("keeps the payload and marks FAILED when the fold throws", async () => {
    const store = memoryStore({
      fold: vi.fn(async () => {
        throw new Error("boom with token ghs_abcdefghijklmnopqrstuvwxyz");
      }),
    });
    const res = await handleWebhook(
      request("installation", installationCreated),
      [SECRET],
      store,
    );
    expect(res.status).toBe(202);
    const row = store.rows.get("delivery-1");
    expect(row?.final?.status).toBe("FAILED");
    expect(row?.payload).not.toBeNull();
    expect(JSON.stringify(row?.final)).not.toContain("ghs_");
  });

  it("does not fold a delivery another worker has claimed", async () => {
    const store = memoryStore({ claimDelivery: vi.fn(async () => false) });
    const res = await handleWebhook(
      request("installation", installationCreated),
      [SECRET],
      store,
    );
    expect(res.status).toBe(202);
    expect(store.fold).not.toHaveBeenCalled();
  });

  it("records workflow events until their fold arrives (M1)", async () => {
    const store = memoryStore();
    const res = await handleWebhook(
      request("workflow_job", {
        action: "queued",
        installation: { id: 1001 },
        workflow_job: { id: 1 },
      }),
      [SECRET],
      store,
    );
    expect(res.status).toBe(202);
    expect(store.fold).not.toHaveBeenCalled();
    expect(store.rows.get("delivery-1")?.final?.status).toBe("SKIPPED");
  });

  it("returns 413 for oversized bodies before verifying anything", async () => {
    const store = memoryStore();
    const req = request("installation", installationCreated);
    req.headers.set("content-length", String(MAX_BODY_BYTES + 1));
    const res = await handleWebhook(req, [SECRET], store);
    expect(res.status).toBe(413);
    expect(store.insertDelivery).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed body that is not JSON", async () => {
    const store = memoryStore();
    const body = "not json";
    const headers = new Headers({
      "x-github-event": "installation",
      "x-github-delivery": "d-2",
      "x-hub-signature-256": signPayload(SECRET, body),
    });
    const res = await handleWebhook({ headers, body }, [SECRET], store);
    expect(res.status).toBe(400);
    expect(store.insertDelivery).not.toHaveBeenCalled();
  });
});

describe("redactError", () => {
  it("removes GitHub tokens and bearer values and truncates", () => {
    const out = redactError(
      "failed: ghs_0123456789abcdef Authorization: Bearer abc.def " +
        "x".repeat(600),
    );
    expect(out).not.toContain("ghs_0123456789abcdef");
    expect(out).not.toContain("abc.def");
    expect(out.length).toBeLessThanOrEqual(500);
  });
});
