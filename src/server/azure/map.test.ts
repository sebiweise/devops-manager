import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildSchema, timelineRecordSchema } from "./client";
import {
  auditIdOfTag,
  auditTagOf,
  buildResultOf,
  buildStatusOf,
  deriveBuild,
  eventOf,
  hitJobCap,
  jobMinutes,
  mapBuild,
  mapTimeline,
  osOf,
  previousTimelines,
} from "./map";

const P = "00000000-0000-4000-8000-000000000011";
const SHA = "b".repeat(40);

describe("status, result, reason and OS", () => {
  it("maps every documented value and falls back", () => {
    expect(buildStatusOf("notStarted")).toBe("NOT_STARTED");
    expect(buildStatusOf("postponed")).toBe("POSTPONED");
    expect(buildStatusOf("cancelling")).toBe("CANCELLING");
    expect(buildStatusOf("weird")).toBe("UNKNOWN");
    expect(buildResultOf("partiallySucceeded")).toBe("PARTIALLY_SUCCEEDED");
    expect(buildResultOf("canceled")).toBe("CANCELED");
    expect(buildResultOf(null)).toBe("NONE");
    expect(eventOf("individualCI")).toBe("push");
    expect(eventOf("batchedCI")).toBe("push");
    expect(eventOf("pullRequest")).toBe("pull_request");
    expect(eventOf("schedule")).toBe("schedule");
    expect(eventOf("manual")).toBe("workflow_dispatch");
    expect(eventOf("triggered")).toBe("other");
    expect(osOf("macOS-14")).toBe("MACOS");
    expect(osOf("windows-latest")).toBe("WINDOWS");
    expect(osOf("ubuntu-22.04")).toBe("LINUX");
    expect(osOf(null, "anything")).toBe("UNKNOWN");
  });
});

describe("mapBuild", () => {
  it("prefers the PR's source SHA and keeps the PR number", () => {
    const b = mapBuild(
      buildSchema.parse({
        id: 5,
        status: "completed",
        result: "succeeded",
        reason: "pullRequest",
        queueTime: "2026-11-13T10:00:00Z",
        startTime: "2026-11-13T10:01:00Z",
        finishTime: "2026-11-13T10:06:00Z",
        sourceBranch: "refs/pull/42/merge",
        sourceVersion: "c".repeat(40),
        definition: { id: 3 },
        triggerInfo: {
          "pr.number": "42",
          "pr.sourceSha": SHA,
          "pr.sourceBranch": "refs/heads/feature/x",
        },
        tags: [auditTagOf("5c0c2d8e-1f4a-4b6c-9d2e-3a4b5c6d7e01")],
      }),
      P,
    )!;
    expect(b).toMatchObject({
      headSha: SHA,
      prNumber: 42,
      headBranch: "feature/x",
      reason: "pull_request",
      durationS: 300,
      auditTag: "5c0c2d8e-1f4a-4b6c-9d2e-3a4b5c6d7e01",
    });
  });

  it("drops a result while the build runs and skips builds without queue time", () => {
    expect(
      mapBuild(
        buildSchema.parse({
          id: 1,
          status: "inProgress",
          result: "failed",
          queueTime: "2026-11-13T10:00:00Z",
          definition: { id: 1 },
        }),
        P,
      )!.result,
    ).toBe("NONE");
    expect(
      mapBuild(
        buildSchema.parse({
          id: 1,
          status: "inProgress",
          definition: { id: 1 },
        }),
        P,
      ),
    ).toBeNull();
  });

  it("never carries an identity or e-mail address (random extra fields)", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 12 }),
          fc.oneof(fc.string(), fc.constant("person@example.com")),
        ),
        (extra) => {
          const raw = buildSchema.safeParse({
            ...extra,
            id: 9,
            queueTime: "2026-11-13T10:00:00Z",
            definition: { id: 1, name: "ci" },
            requestedFor: {
              uniqueName: "person@example.com",
              displayName: "Example Person",
            },
            requestedBy: { uniqueName: "person@example.com" },
          });
          if (!raw.success) return true;
          const row = mapBuild(raw.data, P);
          return (
            !JSON.stringify(row).includes("person@example.com") &&
            !JSON.stringify(row).includes("Example Person")
          );
        },
      ),
    );
  });

  it("parses only dm-audit tags with a UUID", () => {
    expect(auditIdOfTag("dm-audit-not-a-uuid")).toBeNull();
    expect(auditIdOfTag("release")).toBeNull();
  });
});

const rec = (r: Record<string, unknown>) => timelineRecordSchema.parse(r);

describe("timelines and attempts", () => {
  const stage = rec({
    id: "s1",
    type: "Stage",
    name: "Build",
    identifier: "Build",
    state: "completed",
    result: "succeeded",
    attempt: 1,
  });

  it("detects a job that hit the time limit", () => {
    expect(hitJobCap({ result: "canceled", issues: [] }, 3580, 60)).toBe(true);
    expect(
      hitJobCap(
        {
          result: "failed",
          issues: [
            {
              message:
                "The job running on agent X ran longer than the maximum time of 60 minutes",
            },
          ],
        },
        3600,
        60,
      ),
    ).toBe(true);
    expect(
      hitJobCap(
        { result: "failed", issues: [{ message: "exit code 1" }] },
        3600,
        60,
      ),
    ).toBe(false);
    expect(hitJobCap({ result: "canceled", issues: [] }, 600, 60)).toBe(false);
    expect(hitJobCap({ result: "succeeded", issues: [] }, 3600, 60)).toBe(
      false,
    );
  });

  it("derives max attempt, the attempt-1 result and flakiness after a retry", () => {
    const now = "2026-11-13T10:00:00Z";
    const later = "2026-11-13T10:05:00Z";
    const current = [
      stage,
      rec({
        id: "j1",
        parentId: "s1",
        type: "Job",
        name: "build",
        identifier: "Build.build",
        state: "completed",
        result: "succeeded",
        attempt: 1,
        startTime: now,
        finishTime: later,
      }),
      rec({
        id: "j2",
        parentId: "s1",
        type: "Job",
        name: "test",
        identifier: "Build.test",
        state: "completed",
        result: "succeeded",
        attempt: 2,
        startTime: now,
        finishTime: later,
        previousAttempts: [
          { attempt: 1, timelineId: "t-prev", recordId: "j2" },
        ],
      }),
    ];
    expect(previousTimelines(current)).toEqual([
      { attempt: 1, timelineId: "t-prev" },
    ]);
    const rows = [
      ...mapTimeline(current, 60),
      ...mapTimeline(
        [
          rec({
            id: "j2",
            type: "Job",
            name: "test",
            identifier: "Build.test",
            state: "completed",
            result: "failed",
            startTime: now,
            finishTime: later,
          }),
        ],
        60,
        1,
      ),
    ];
    const d = deriveBuild(
      {
        result: "SUCCEEDED",
        status: "COMPLETED",
        queuedAt: new Date("2026-11-13T09:59:00Z"),
      },
      rows,
    );
    expect(d).toMatchObject({
      maxAttempt: 2,
      firstAttemptResult: "FAILED",
      timedOut: false,
      queueS: 60,
    });
    expect(
      rows.find(
        (r) => r.type === "Job" && r.attempt === 1 && r.name === "test",
      )!.stageIdentifier,
    ).toBeNull();
    expect(rows.find((r) => r.name === "build")!.stageIdentifier).toBe("Build");
  });

  it("uses the build's own result without a retry", () => {
    const rows = mapTimeline(
      [
        stage,
        rec({
          id: "j1",
          parentId: "s1",
          type: "Job",
          name: "build",
          state: "completed",
          result: "failed",
          attempt: 1,
        }),
      ],
      60,
    );
    expect(
      deriveBuild(
        { result: "FAILED", status: "COMPLETED", queuedAt: new Date() },
        rows,
      ).firstAttemptResult,
    ).toBe("FAILED");
  });

  it("rounds billed minutes up per job", () => {
    expect(jobMinutes(new Date(0), new Date(61_000))).toBe(2);
    expect(jobMinutes(new Date(0), null)).toBe(0);
  });
});
