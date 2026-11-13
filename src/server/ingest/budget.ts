/**
 * Time and rate budgets for reconcile (design §5.3).
 *
 * - `Deadline`: the work loop stops at `getDeadline() - 30 s` on Vercel (300 s
 *   functions), after a 240 s soft budget elsewhere, and after 60 s for lazy
 *   reconcile and Sync now. Every step checks it between units of work and
 *   persists its cursor, so the next tick resumes where this one stopped.
 * - `RateBudget`: tracks GitHub's rate-limit headers per installation. Sync
 *   and backfill pause when the remaining budget falls below
 *   max(500, 25% of the limit), keeping a reserve for interactive use.
 */

export const VERCEL_MARGIN_MS = 30_000;
export const SOFT_BUDGET_MS = 240_000;
export const LAZY_BUDGET_MS = 60_000;

export class Deadline {
  constructor(
    readonly endsAt: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Deadline for a request: the platform deadline minus the margin, or a soft budget. */
  static forRequest(
    platformDeadline: Date | undefined,
    budgetMs: number = SOFT_BUDGET_MS,
    clock: () => number = Date.now,
  ): Deadline {
    const soft = clock() + budgetMs;
    const hard = platformDeadline
      ? platformDeadline.getTime() - VERCEL_MARGIN_MS
      : Infinity;
    return new Deadline(Math.min(soft, hard), clock);
  }

  now(): number {
    return this.clock();
  }

  remainingMs(): number {
    return this.endsAt - this.clock();
  }

  /** True when less than `reserveMs` is left. */
  expired(reserveMs = 0): boolean {
    return this.remainingMs() <= reserveMs;
  }
}

export class DeadlineReached extends Error {
  constructor() {
    super("reconcile deadline reached");
    this.name = "DeadlineReached";
  }
}

export type RateSnapshot = {
  resource: string;
  limit: number;
  remaining: number;
  resetAt: Date;
};

export class RateLimited extends Error {
  constructor(readonly retryAt: Date | null) {
    super("GitHub rate budget paused");
    this.name = "RateLimited";
  }
}

type Headers = Record<string, string | number | undefined>;

const num = (v: string | number | undefined) =>
  v === undefined || v === "" ? Number.NaN : Number(v);

export class RateBudget {
  readonly snapshots = new Map<string, RateSnapshot>();
  private pausedUntil = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  /** Reads `x-ratelimit-*` and `retry-after` from a response (or error response). */
  observe(headers: Headers | undefined, status?: number): void {
    if (!headers) return;
    const limit = num(headers["x-ratelimit-limit"]);
    const remaining = num(headers["x-ratelimit-remaining"]);
    const reset = num(headers["x-ratelimit-reset"]);
    const resource = String(headers["x-ratelimit-resource"] ?? "core");
    if (Number.isFinite(limit) && Number.isFinite(remaining)) {
      this.snapshots.set(resource, {
        resource,
        limit,
        remaining,
        resetAt: new Date(
          Number.isFinite(reset) ? reset * 1000 : this.clock() + 3_600_000,
        ),
      });
    }
    const retryAfter = num(headers["retry-after"]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      this.pausedUntil = Math.max(
        this.pausedUntil,
        this.clock() + retryAfter * 1000,
      );
    } else if (
      (status === 403 || status === 429) &&
      Number.isFinite(remaining) &&
      remaining === 0 &&
      Number.isFinite(reset)
    ) {
      this.pausedUntil = Math.max(this.pausedUntil, reset * 1000);
    }
  }

  /** The reserve below which sync and backfill pause. */
  static reserve(limit: number): number {
    return Math.max(500, Math.ceil(limit * 0.25));
  }

  /**
   * The floor below which interactive reads (run steps) stop calling GitHub.
   * It lies below the sync reserve, so the reserve serves interactive use and
   * stale repair, but a page left open cannot drain the last requests that
   * webhook repair and Sync now need.
   */
  static interactiveFloor(limit: number): number {
    return Math.max(100, Math.ceil(limit * 0.05));
  }

  /** True when steps d-f must pause for this installation. */
  paused(): boolean {
    if (this.clock() < this.pausedUntil) return true;
    const core = this.snapshots.get("core");
    if (!core) return false;
    if (core.resetAt.getTime() <= this.clock()) return false;
    return core.remaining < RateBudget.reserve(core.limit);
  }

  /** True only for an explicit retry-after or an exhausted limit (step c still runs otherwise). */
  blocked(): boolean {
    return this.clock() < this.pausedUntil;
  }

  retryAt(): Date | null {
    return this.pausedUntil > this.clock() ? new Date(this.pausedUntil) : null;
  }
}
