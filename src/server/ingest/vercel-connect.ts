import "server-only";
import { db } from "@/server/db";
import {
  createVercelClient,
  VercelError,
  type Fetch,
  type VercelTeam,
} from "@/server/vercel/client";
import {
  isAllowedVercelTeam,
  tokenHintOf,
  type EnvVercelToken,
} from "./vercel-credential";

/**
 * Validation of a Vercel token before anything is stored (design addendum
 * §5.1 step 4), shared by Connect, Rotate and the env-token shortcut:
 *
 * 1. `GET /v2/user` answers 200 (else: invalid token).
 * 2. `GET /v5/user/tokens/current` tells the token's scopes and expiry, if
 *    the token may read them.
 * 3. Exactly one team: the given team id (`GET /v2/teams/{id}`), the single
 *    team a team-scoped token is bound to, or the only team of a full-account
 *    token (`GET /v2/teams`). A full-account token with several teams and no
 *    team id is ambiguous and refused.
 * 4. ALLOWED_VERCEL_TEAMS.
 *
 * Only GETs. Errors are codes for the UI; no Vercel message is echoed.
 */

export type TokenCheckError =
  | "invalid_token"
  | "token_expired"
  | "team_required"
  | "team_not_found"
  | "team_mismatch"
  | "no_team"
  | "team_not_allowed"
  | "rate_limited"
  | "vercel_unavailable";

export type TokenCheck =
  | {
      ok: true;
      team: VercelTeam;
      scope: "team" | "full" | null;
      expiresAt: Date | null;
      hint: string;
    }
  | { ok: false; error: TokenCheckError };

function mapError(error: unknown): TokenCheckError {
  if (error instanceof VercelError) {
    if (error.revoked) return "invalid_token";
    if (error.rateLimited) return "rate_limited";
  }
  return "vercel_unavailable";
}

const TEAM_ID = /^team_[A-Za-z0-9]{1,64}$/;

export function isTeamId(value: string): boolean {
  return TEAM_ID.test(value);
}

export async function checkVercelToken(
  token: string,
  teamId: string | null,
  fetchImpl?: Fetch,
  now: Date = new Date(),
): Promise<TokenCheck> {
  const api = createVercelClient({ token, fetch: fetchImpl });
  try {
    await api.getUser();
  } catch (error) {
    return { ok: false, error: mapError(error) };
  }
  let info;
  try {
    info = await api.getCurrentToken();
  } catch (error) {
    return { ok: false, error: mapError(error) };
  }
  if (info?.expiresAt && info.expiresAt <= now)
    return { ok: false, error: "token_expired" };

  let team: VercelTeam;
  try {
    if (teamId) {
      if (
        info &&
        !info.full &&
        info.teamIds.length > 0 &&
        !info.teamIds.includes(teamId)
      )
        return { ok: false, error: "team_mismatch" };
      try {
        team = await api.getTeam(teamId);
      } catch (error) {
        if (
          error instanceof VercelError &&
          (error.status === 403 || error.status === 404) &&
          !error.tokenRejected
        )
          return { ok: false, error: "team_not_found" };
        throw error;
      }
    } else if (info && !info.full && info.teamIds.length === 1) {
      team = await api.getTeam(info.teamIds[0]!);
    } else if (info && !info.full && info.teamIds.length > 1) {
      return { ok: false, error: "team_required" };
    } else {
      const teams = await api.listTeams();
      if (teams.length === 0) return { ok: false, error: "no_team" };
      if (teams.length > 1) return { ok: false, error: "team_required" };
      team = teams[0]!;
    }
  } catch (error) {
    return { ok: false, error: mapError(error) };
  }
  if (!isAllowedVercelTeam(team))
    return { ok: false, error: "team_not_allowed" };
  return {
    ok: true,
    team,
    scope: info ? (info.full ? "full" : "team") : null,
    expiresAt: info?.expiresAt ?? null,
    hint: tokenHintOf(token),
  };
}

const envAttempts = new Map<string, number>();
const ENV_RETRY_MS = 10 * 60_000;

/**
 * The env-token shortcut (addendum §5.2): VERCEL_TOKEN belongs to the
 * installation of VERCEL_ACCOUNT. Without a connection row, the token is
 * validated (at most every 10 minutes per process) and a row with
 * `tokenSource = ENV` and no stored token is created. A row an admin
 * connected in the UI is left alone.
 */
export async function ensureEnvConnection(
  installationId: bigint,
  envToken: EnvVercelToken,
  fetchImpl: Fetch | undefined,
  now: Date,
): Promise<"created" | "exists" | "not_applicable" | "refused"> {
  const inst = await db.installation.findUnique({
    where: { id: installationId },
    select: {
      accountLogin: true,
      vercel: { select: { installationId: true } },
    },
  });
  if (
    !inst ||
    inst.accountLogin.toLowerCase() !== envToken.accountLogin.toLowerCase()
  )
    return "not_applicable";
  if (inst.vercel) return "exists";
  const key = String(installationId);
  const last = envAttempts.get(key);
  if (last && now.getTime() - last < ENV_RETRY_MS) return "refused";
  envAttempts.set(key, now.getTime());
  const check = await checkVercelToken(
    envToken.token,
    envToken.teamId,
    fetchImpl,
    now,
  );
  if (!check.ok) {
    console.warn("VERCEL_TOKEN refused:", check.error);
    return "refused";
  }
  const taken = await db.vercelConnection.findUnique({
    where: { teamId: check.team.id },
    select: { installationId: true },
  });
  if (taken) {
    console.warn("VERCEL_TOKEN refused: team already connected elsewhere");
    return "refused";
  }
  await db.vercelConnection.create({
    data: {
      installationId,
      teamId: check.team.id,
      teamSlug: check.team.slug,
      teamName: check.team.name,
      plan: check.team.plan,
      tokenSource: "ENV",
      accessToken: null,
      tokenHint: check.hint,
      tokenScope: check.scope,
      tokenExpiresAt: check.expiresAt,
      createdByUserId: "env",
    },
  });
  envAttempts.delete(key);
  return "created";
}

/** Tests only. */
export function resetEnvAttempts(): void {
  envAttempts.clear();
}
