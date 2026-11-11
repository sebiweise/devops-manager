import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { csv, env } from "@/env";
import { roleRulesFromEnv, signInGateFromEnv } from "@/server/authz/config";
import {
  evaluateSignIn,
  readGroupsClaim,
  resolveEnvRole,
  type Role,
} from "@/server/authz/roles";
import { db } from "@/server/db";
import {
  pseudonymiseSessionIp,
  readEmailVerified,
  stripAccountTokens,
} from "./hooks";
import { decisionFor, rememberDecision } from "./sign-in-context";

/**
 * better-auth, used directly (design §3.5, D1, D9).
 *
 * - Primary login: a generic OIDC provider (`providerId: "oidc"`) through the
 *   genericOAuth plugin, with discovery, PKCE, state and a nonce-bound,
 *   JWKS-verified ID token.
 * - Optional: GitHub, only when GITHUB_LOGIN_ENABLED=true.
 * - No self-registration: `user.validateUserInfo` refuses identities without a
 *   resolvable role before a user row exists, and `session.create.before`
 *   refuses sessions outside that gate.
 * - Provider tokens are dropped before account rows are written.
 * - No implicit account linking; GitHub is linked explicitly while signed in.
 */

export const OIDC_PROVIDER_ID = "oidc";
export const GITHUB_PROVIDER_ID = "github";

/** Session cookie: `__Host-dm.session_token` over https, `dm.session_token` otherwise. */
const COOKIE_PREFIX = "dm";

export const githubLoginEnabled = () =>
  env.GITHUB_LOGIN_ENABLED &&
  !!env.GITHUB_APP_CLIENT_ID &&
  !!env.GITHUB_APP_CLIENT_SECRET;

async function storedState(userId: string | undefined) {
  if (!userId) return {};
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { roleOverride: true, disabledAt: true },
  });
  return {
    roleOverride: (user?.roleOverride ?? null) as Role | null,
    disabledAt: user?.disabledAt ?? null,
  };
}

function createAuth() {
  // Read here, not at module level: `next build` imports this module with
  // SKIP_ENV_VALIDATION and without any of these variables.
  const isHttps = env.BETTER_AUTH_URL.startsWith("https://");
  const issuer = env.OIDC_ISSUER.replace(/\/+$/, "");
  /** `__Host-` cookies need Secure, Path=/ and no Domain, so only over https. */
  const hostCookie = (name: string) =>
    isHttps
      ? {
          name: `__Host-${COOKIE_PREFIX}.${name}`,
          attributes: { secure: true, path: "/" },
        }
      : {};

  return betterAuth({
    appName: "DevOps Manager",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: "postgresql" }),
    trustedOrigins: [env.BETTER_AUTH_URL],
    onAPIError: { errorURL: "/login" },

    emailAndPassword: { enabled: false },

    session: {
      expiresIn: env.SESSION_MAX_AGE_HOURS * 60 * 60,
      updateAge: 60 * 60,
    },

    user: {
      additionalFields: {
        // None of these can be set through better-auth's user endpoints.
        locale: { type: "string", required: false, input: false },
        oidcGroups: { type: "string[]", required: false, input: false },
        envRole: { type: "string", required: false, input: false },
        roleOverride: { type: "string", required: false, input: false },
        disabledAt: { type: "date", required: false, input: false },
        lastLoginAt: { type: "date", required: false, input: false },
      },

      /**
       * The sign-in gate. Runs before a user is created, before an account is
       * linked, and on every OAuth sign-in with the fresh provider profile.
       */
      validateUserInfo: async ({ user, source }) => {
        const providerId = source.oauth?.providerId;
        if (source.method !== "oauth" || !providerId)
          return { error: "unsupported_sign_in" };
        if (
          providerId !== OIDC_PROVIDER_ID &&
          !(providerId === GITHUB_PROVIDER_ID && githubLoginEnabled())
        ) {
          return { error: "provider_disabled" };
        }
        const email = typeof user.email === "string" ? user.email : "";
        if (!email) return { error: "email_missing" };

        // Linking GitHub to a signed-in user adds a way in; the gate runs again
        // when that way is used.
        if (source.action === "link-account") return;

        const profile = source.oauth?.profile ?? {};
        const isOidc = providerId === OIDC_PROVIDER_ID;
        const identity = {
          email,
          emailVerified: isOidc
            ? readEmailVerified(profile)
            : user.emailVerified === true,
          groups: isOidc ? readGroupsClaim(profile, env.OIDC_GROUPS_CLAIM) : [],
        };
        const rules = roleRulesFromEnv();
        const stored = await storedState(
          typeof user.id === "string" && source.action === "sign-in"
            ? user.id
            : undefined,
        );
        const decision = evaluateSignIn(
          identity,
          stored,
          rules,
          signInGateFromEnv(),
        );
        if (!decision.ok) return { error: decision.error };

        const gate = signInGateFromEnv();
        rememberDecision(email, {
          provider: providerId,
          role: decision.role,
          envRole: resolveEnvRole(
            {
              ...identity,
              emailVerified: gate.requireVerifiedEmail
                ? identity.emailVerified
                : true,
            },
            rules,
          ),
          groups: decision.groups,
        });
      },
    },

    account: {
      // Fresh tokens are not needed on sign-in either.
      updateAccountOnSignIn: false,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: [],
        allowDifferentEmails: false,
      },
    },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const decision = decisionFor(user.email);
            // No gate decision in this request: nobody gets a row.
            if (!decision) return false;
            return {
              data: {
                ...user,
                oidcGroups:
                  decision.provider === OIDC_PROVIDER_ID ? decision.groups : [],
                envRole: decision.envRole,
                lastLoginAt: new Date(),
              },
            };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await db.user.findUnique({
              where: { id: session.userId },
              select: { id: true, email: true },
            });
            const decision = user ? decisionFor(user.email) : undefined;
            if (!user || !decision) {
              throw new APIError("FORBIDDEN", {
                code: "no_access",
                message: "no access to this instance",
              });
            }
            await db.user.update({
              where: { id: user.id },
              data: {
                lastLoginAt: new Date(),
                envRole: decision.envRole,
                // The effective role is re-resolved from this snapshot on every
                // request (authz/scope.ts). A GitHub sign-in carries no groups,
                // so it clears the snapshot: groups removed at the IdP must not
                // keep granting a role through another way in. The next OIDC
                // sign-in restores the current groups.
                oidcGroups:
                  decision.provider === OIDC_PROVIDER_ID ? decision.groups : [],
              },
            });
            return {
              data: pseudonymiseSessionIp(session, env.AUDIT_IP_SALT),
            };
          },
        },
        update: {
          before: async (session) => ({
            data: pseudonymiseSessionIp(session, env.AUDIT_IP_SALT),
          }),
        },
      },
      account: {
        create: {
          before: async (account) => ({ data: stripAccountTokens(account) }),
        },
        update: {
          before: async (account) => ({ data: stripAccountTokens(account) }),
        },
      },
    },

    socialProviders: githubLoginEnabled()
      ? {
          github: {
            clientId: env.GITHUB_APP_CLIENT_ID!,
            clientSecret: env.GITHUB_APP_CLIENT_SECRET!,
            // GitHub has no groups claim; never let it overwrite the OIDC snapshot.
            overrideUserInfoOnSignIn: false,
          },
        }
      : {},

    plugins: [
      genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER_ID,
            name: env.OIDC_PROVIDER_NAME,
            discoveryUrl: `${issuer}/.well-known/openid-configuration`,
            requireIdTokenVerification: true,
            clientId: env.OIDC_CLIENT_ID,
            clientSecret: env.OIDC_CLIENT_SECRET,
            scopes: csv(env.OIDC_SCOPES.replace(/\s+/g, ",")),
            pkce: true,
            overrideUserInfo: true,
            mapProfileToUser: (profile) => ({
              emailVerified: readEmailVerified(profile),
              name:
                (typeof profile.name === "string" && profile.name) ||
                (typeof profile.preferred_username === "string" &&
                  profile.preferred_username) ||
                "",
            }),
          },
        ],
      }),
      // Must stay last: lets Server Actions set auth cookies.
      nextCookies(),
    ],

    advanced: {
      // Client IPs feed rate limiting; sessions store only their HMAC (see
      // the session hooks). Read them only from headers the trusted proxy
      // sets and overwrites (TRUSTED_IP_HEADERS).
      ipAddress: { ipAddressHeaders: csv(env.TRUSTED_IP_HEADERS) },
      useSecureCookies: false,
      cookiePrefix: COOKIE_PREFIX,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: isHttps,
        path: "/",
      },
      cookies: {
        session_token: hostCookie("session_token"),
        session_data: hostCookie("session_data"),
        dont_remember: hostCookie("dont_remember"),
        account_data: hostCookie("account_data"),
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

/**
 * The better-auth instance, created on first use. Creating it starts OIDC
 * discovery, which must not run while `next build` collects page data.
 */
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

export type Session = Auth["$Infer"]["Session"];
