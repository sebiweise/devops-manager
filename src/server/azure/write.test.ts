import { describe, expect, it } from "vitest";
import type { Fetch } from "./client";
import { AzureError } from "./client";
import { clearEntraCache, entraToken, tokenUrl } from "./entra";
import { buildAzureLogExcerpt } from "./log-excerpt";
import { azureErrorInfo, createAzureWriteClient, refNameOf } from "./write";

const PAT = "test-pat-not-real-0002"; // gitleaks:allow (test placeholder)
const P = "00000000-0000-4000-8000-000000000011";
const TENANT = "00000000-0000-4000-8000-0000000000aa";
const CLIENT = "00000000-0000-4000-8000-0000000000bb";
const SECRET = "test-secret-not-real-0001"; // gitleaks:allow (test placeholder)

function recorder(body: unknown = {}, status = 200) {
  const calls: Array<{ method: string; url: URL; body: unknown }> = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({
      method: init.method ?? "GET",
      url,
      body:
        typeof init.body === "string"
          ? init.body.startsWith("{")
            ? JSON.parse(init.body)
            : init.body
          : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
}

describe("write client", () => {
  it("pins the method, path and body of every call", async () => {
    const r = recorder({ id: 77 });
    const w = createAzureWriteClient({
      org: "contoso-ci",
      auth: { kind: "basic", pat: PAT },
      fetch: r.fetch,
    });
    await w.previewRun(P, 3, "main");
    await w.queueRun(P, 3, "refs/heads/main");
    await w.cancel(P, 77);
    await w.retry(P, 77);
    await w.retryStage(P, 77, "Build");
    await w.addTag(P, 77, "dm-audit-5c0c2d8e-1f4a-4b6c-9d2e-3a4b5c6d7e01");
    await w.createHook({
      projectId: P,
      eventType: "build.complete",
      url: "https://devops.example.com/api/azure/hooks/k",
      username: "k",
      password: "p",
    });
    await w.createHook({
      projectId: P,
      eventType: "ms.vss-pipelines.run-state-changed-event",
      url: "https://devops.example.com/api/azure/hooks/k",
      username: "k",
      password: "p",
    });
    const seen = r.calls.map(
      (c) =>
        `${c.method} ${c.url.pathname}${c.url.searchParams.get("retry") ? "?retry" : ""}`,
    );
    expect(seen).toEqual([
      `POST /contoso-ci/${P}/_apis/pipelines/3/runs`,
      `POST /contoso-ci/${P}/_apis/pipelines/3/runs`,
      `PATCH /contoso-ci/${P}/_apis/build/builds/77`,
      `PATCH /contoso-ci/${P}/_apis/build/builds/77?retry`,
      `PATCH /contoso-ci/${P}/_apis/build/builds/77/stages/Build`,
      `PUT /contoso-ci/${P}/_apis/build/builds/77/tags/dm-audit-5c0c2d8e-1f4a-4b6c-9d2e-3a4b5c6d7e01`,
      "POST /contoso-ci/_apis/hooks/subscriptions",
      "POST /contoso-ci/_apis/hooks/subscriptions",
    ]);
    expect(r.calls[0]!.body).toEqual({
      previewRun: true,
      resources: { repositories: { self: { refName: "refs/heads/main" } } },
    });
    expect(r.calls[1]!.body).toEqual({
      resources: { repositories: { self: { refName: "refs/heads/main" } } },
    });
    expect(r.calls[2]!.body).toEqual({ status: "cancelling" });
    expect(r.calls[4]!.body).toEqual({
      state: "retry",
      forceRetryAllJobs: false,
    });
    expect(JSON.stringify(r.calls[1]!.body)).not.toMatch(
      /templateParameters|variables|yamlOverride|stagesToSkip/,
    );
    expect(r.calls[7]!.body).toMatchObject({
      publisherId: "pipelines",
      resourceVersion: "5.1-preview.1",
    });
    expect(r.calls[6]!.body).toMatchObject({
      publisherId: "tfs",
      resourceVersion: "2.0",
      consumerId: "webHooks",
      consumerInputs: {
        basicAuthUsername: "k",
        basicAuthPassword: "p",
        resourceDetailsToSend: "minimal",
        messagesToSend: "none",
      },
    });
  });

  it("refuses invalid refs, stage ids, tags and plain HTTP hooks", async () => {
    const w = createAzureWriteClient({
      org: "contoso-ci",
      auth: { kind: "basic", pat: PAT },
      fetch: recorder().fetch,
    });
    expect(() => refNameOf("feature/../x")).toThrow();
    expect(() => refNameOf("main branch")).toThrow();
    expect(refNameOf("feature/x")).toBe("refs/heads/feature/x");
    await expect(w.retryStage(P, 1, "Build; DROP")).rejects.toThrow();
    await expect(w.addTag(P, 1, "a/b")).rejects.toThrow();
    await expect(
      w.createHook({
        projectId: P,
        eventType: "build.complete",
        url: "http://x.example.com",
        username: "u",
        password: "p",
      }),
    ).rejects.toThrow();
    await expect(
      w.createHook({
        projectId: P,
        eventType: "git.push",
        url: "https://x.example.com",
        username: "u",
        password: "p",
      }),
    ).rejects.toThrow();
  });

  it("marks network failures and timeouts as an unknown outcome", () => {
    expect(
      azureErrorInfo(
        new AzureError(null, "network", "socket hang up", null, "/x"),
      ).message,
    ).toMatch(/^outcome_unknown/);
    expect(
      azureErrorInfo(new AzureError(504, "timeout", "timed out", "a1", "/x")),
    ).toMatchObject({ status: null, requestId: "a1" });
    expect(
      azureErrorInfo(new AzureError(400, "bad_request", "no", "a2", "/x")),
    ).toEqual({ status: 400, message: "bad_request: no", requestId: "a2" });
  });
});

describe("Microsoft Entra client credentials", () => {
  it("asks login.microsoftonline.com for the Azure DevOps resource and caches the token", async () => {
    clearEntraCache();
    const r = recorder({
      access_token: "eyJhdGVzdA.payload.signature",
      expires_in: 3600,
    });
    const t1 = await entraToken(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      { fetch: r.fetch },
    );
    const t2 = await entraToken(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      { fetch: r.fetch },
    );
    expect(t1.token).toBe(t2.token);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url.origin).toBe("https://login.microsoftonline.com");
    expect(r.calls[0]!.url.pathname).toBe(`/${TENANT}/oauth2/v2.0/token`);
    const form = new URLSearchParams(String(r.calls[0]!.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe(
      "499b84ac-1321-427f-aa17-267ca6975798/.default",
    );
  });

  it("reports a rejected secret as revoked, without echoing Entra's text", async () => {
    clearEntraCache();
    const r = recorder(
      {
        error: "invalid_client",
        error_codes: [7000215],
        error_description: `AADSTS7000215 ${CLIENT}`,
      },
      401,
    );
    const err = (await entraToken(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      { fetch: r.fetch },
    ).catch((e: unknown) => e)) as { revoked: boolean; message: string };
    expect(err.revoked).toBe(true);
    expect(err.message).not.toContain(CLIENT);
  });

  it("only builds token URLs for GUID tenants", () => {
    expect(() => tokenUrl("evil.example.com/../x")).toThrow();
  });
});

describe("log excerpt", () => {
  it("scrubs the credential, the organisation and token patterns and caps the size", () => {
    const pat84 = `${"A".repeat(76)}AZDO${"b".repeat(4)}`;
    const raw = [
      "2026-11-13T10:00:00.0000000Z ##[section]Starting build",
      `2026-11-13T10:00:01.0000000Z using ${PAT} for contoso-ci`,
      `2026-11-13T10:00:02.0000000Z leaked ${pat84}`,
      "2026-11-13T10:00:03.0000000Z ##[error]Bearer eyJhbGciOi.payload12345.signature99",
      ...Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(400)}`),
    ].join("\n");
    const ex = buildAzureLogExcerpt(raw, [PAT, "contoso-ci"]);
    const text = ex.lines.map((l) => l.text).join("\n");
    expect(text).not.toContain(PAT);
    expect(text).not.toContain("contoso-ci");
    expect(text).not.toContain(pat84);
    expect(ex.lines.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(ex.truncated).toBe(true);
    const short = buildAzureLogExcerpt(raw.split("\n").slice(0, 4).join("\n"), [
      PAT,
      "contoso-ci",
    ]);
    expect(short.lines[0]).toMatchObject({
      stream: "cmd",
      at: "2026-11-13T10:00:00.000Z",
    });
    expect(short.lines[3]!.stream).toBe("err");
    expect(short.lines[3]!.text).not.toContain("eyJhbGciOi");
  });
});
