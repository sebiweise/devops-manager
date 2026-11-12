# DevOps Manager

Self-hosted GitHub Actions insights and management for a personal account and
any number of organisations, through **one least-privilege GitHub App**.

- Sign-in goes through **your own OIDC provider** (any standards-compliant
  issuer). Nobody needs a GitHub account to use the app; GitHub login is an
  optional second provider.
- What a user may do comes from **app roles** (viewer, operator, admin),
  assigned by email or group allowlists.
- Everything the app does on GitHub is done **by the GitHub App itself** with
  short-lived installation tokens narrowed per purpose; the audit log records
  which app user triggered it.
- One codebase, two hosting modes: **Vercel Hobby + Neon Free**, or
  **`docker compose up`** (app, Postgres, cron sidecar).

> Status: **M2** (runners and costs). Management actions arrive with M3.
> See [Features by milestone](#features-by-milestone).

## Contents

- [Features by milestone](#features-by-milestone)
- [How it works](#how-it-works)
- [GitHub App permissions](#github-app-permissions)
- [What is stored](#what-is-stored)
- [Setup](#setup)
  - [1. Register the GitHub App](#1-register-the-github-app)
  - [2. Configure the OIDC provider](#2-configure-the-oidc-provider)
  - [3a. Deploy on Vercel Hobby with Neon](#3a-deploy-on-vercel-hobby-with-neon)
  - [3b. Run with Docker Compose](#3b-run-with-docker-compose)
  - [4. Install the App and sign in](#4-install-the-app-and-sign-in)
  - [5. Optional: personal-account billing](#5-optional-personal-account-billing)
- [Sync and freshness](#sync-and-freshness)
- [Roles](#roles)
- [Configuration](#configuration)
- [Development](#development)
- [License](#license)

## Features by milestone

| Milestone                               | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0**                                  | OIDC login via better-auth (generic provider, optional GitHub), sign-in gate and roles from env allowlists, installation discovery with the App JWT, onboarding with Setup URL verification, dashboard with a live repository list across installations, webhook endpoint (HMAC, dedupe, installation and repository events), encrypted token storage helpers, health and readiness probes, CSP and security headers, Docker and Vercel setups, CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **M1** Actions insights                 | Workflow runs and jobs with an order-independent fold, reconcile (replay, redelivery, incremental sync, backfill), lazy reconcile on page view and Sync now, daily rollups with histograms, success rate, p50/p95 durations, queue times, flaky-run and regression detection, estimated minutes (minutes only). Pages: installation overview (KPI tiles, runs per day, duration and queue charts, regressions, flaky jobs, success drops), repositories (sortable, filterable, 14-day sparklines), repository detail (workflows, runs with filters), workflow detail (trends, job breakdown by pool, hosted vs self-hosted), run detail (job timeline with queue, approval wait and execution, critical path, steps loaded live), workflow leaderboards, sync health (admin), freshness banner. Every chart has an aria-label, a caption and a table view (sparklines: a per-row table disclosure); the chart components are checked with axe-core in the unit tests |
| **M2** Runners and costs (this release) | Runner cache with sampling on reconcile and lazily on the runner and queue pages, daily discovery of repository and organisation runners, utilisation (busy / online, with the sample interval shown and "insufficient samples" below 50% coverage), speed index, infrastructure failures, concurrency timeline, pools with a weekday × hour queue heatmap, hosted vs self-hosted comparison; live queue with STUCK and no-matching-runner flags and a separate approvals section; daily billing sync for organisations (installation token) and personal accounts (optional billing credential: token or "Connect GitHub"); costs page with month picker, used vs included gauge with projection, by SKU, repository, day and workflow (estimated, scaled), estimate vs billed with flags, estimate-only fallback with the reason; `/admin/github` for the billing credential. Charts have an aria-label, a caption and a table view and are checked with axe-core  |
| **M3** Management                       | Re-run, re-run failed, cancel (operator); repository and organisation variables with `LINUX_RUNNER` / `MACOS_RUNNER` presets, bulk set and revert, SHA-pinned PR merge and guarded Dependabot batch merge (admin); hash-chained audit log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **M4** Polish, v0.1.0                   | Complete German translation, user and role management, `/admin/ops`, setup wizard, full docs, signed GHCR image                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## How it works

```
GitHub App  --webhooks (HMAC)-->  /api/github/webhook  --> Postgres
            <--installation tokens (per purpose)-- token broker
OIDC issuer <--code + PKCE + nonce--> /api/auth/*  (better-auth)
Browser     --session cookie-->  pages (role-gated, tenant-scoped)
Scheduler   --Bearer CRON_SECRET--> /api/cron/reconcile
```

- Identity, app permissions and GitHub access are separate: who you are comes
  from the OIDC provider, what you may do comes from your app role, and what the
  app may do on GitHub comes only from the App installation.
- Freshness comes from webhooks, a lazy reconcile when a page is older than
  15 minutes (M1), the daily Vercel cron, or the 10-minute Docker cron sidecar.
  No Vercel beta features are used.

## GitHub App permissions

Two manifests are shipped: [`github-app-manifest.json`](github-app-manifest.json)
(manage profile) and [`github-app-manifest.readonly.json`](github-app-manifest.readonly.json)
(pair with `MANAGEMENT_ENABLED=false`). Each feature checks the permissions the
installation actually granted and shows a "permission not granted" note instead
of failing.

| Permission                        | Manage | Read-only | Used for                                                                                                          | Feature (milestone)             |
| --------------------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Repository: Metadata              | read   | read      | repository list                                                                                                   | dashboard (M0)                  |
| Repository: Actions               | write  | read      | runs and jobs, `workflow_run`/`workflow_job` webhooks; re-run and cancel                                          | insights (M1), run actions (M3) |
| Repository: Contents              | write  | read      | `PUT /pulls/{n}/merge`                                                                                            | PR merge (M3)                   |
| Repository: Pull requests         | write  | read      | PR list, merge state, merge                                                                                       | PRs (M3)                        |
| Repository: Workflows             | write  | —         | merging PRs that change `.github/workflows` (e.g. Dependabot updates of Actions); only requested for those merges | PR merge (M3)                   |
| Repository: Checks                | read   | read      | check rollup in the PR list (optional)                                                                            | PRs (M3)                        |
| Repository: Commit statuses       | read   | read      | status rollup in the PR list (optional)                                                                           | PRs (M3)                        |
| Repository: Variables             | write  | read      | repository Actions variables and the runs-on presets                                                              | variables (M3)                  |
| Repository: Dependabot alerts     | read   | read      | alert overview (optional)                                                                                         | Dependabot (M3)                 |
| Repository: Administration        | read   | read      | repository-level self-hosted runners (without it, runners are known from job data only)                           | runners (M2)                    |
| Organization: Self-hosted runners | read   | read      | organisation runners and runner groups (optional)                                                                 | runners (M2)                    |
| Organization: Variables           | write  | read      | organisation Actions variables (optional)                                                                         | variables (M3)                  |
| Organization: Administration      | read   | read      | organisation billing usage (optional; without it costs are estimates)                                             | costs (M2)                      |
| Account: Email addresses          | read   | read      | verified email for the optional GitHub login (removable)                                                          | login (M0)                      |
| Account: Plan                     | read   | read      | personal-account billing via "Connect GitHub" (removable; option A needs it on the token instead)                 | costs (M2)                      |

Webhook events: `workflow_run`, `workflow_job`, `repository` (subscribed);
`installation`, `installation_repositories`, `github_app_authorization`
(delivered automatically). Not requested: secrets, environments, issues,
deployments, members, codespaces.

Because the App acts as itself, GitHub shows `<app-slug>[bot]` as the actor of
re-runs, variable changes and merges. Branch rulesets apply to the App like to
any actor; add it to a ruleset's bypass list yourself if you want it to bypass.

## What is stored

- Installations and repositories of allowed accounts (names, visibility,
  default branch, granted permissions).
- From M1: normalised workflow run and job metadata, including the logins of
  GitHub actors. Raw run and job rows are kept for 90 days by default
  (`DEFAULT_RETENTION_DAYS`); daily rollups are kept.
- App users: email, name, the groups snapshot of the last sign-in, roles and
  login times. Provider access, refresh and ID tokens are **not** stored.
- From M2: the self-hosted runners of each installation (name, labels, OS,
  group, online and busy state), runner samples (online and busy at a point
  in time) and daily runner stats; the Actions billing usage report (SKU,
  repository, day, quantity and amounts); an optional billing credential of a
  personal account, **encrypted** with `TOKEN_ENCRYPTION_KEY` and never
  logged or shown again.
- Webhook deliveries for 14 days; payloads are dropped once processed.
- Audit entries (from M3) for 400 days; IP addresses only as a salted hash.
- Never stored: logs, job steps, Actions secrets.

An installation's data is hidden immediately after uninstall and deleted
after 30 days.

## Setup

### 1. Register the GitHub App

Each deployment registers its own App. See [docs/SETUP.md](docs/SETUP.md) for
the manifest flow; in short:

1. Pick the manifest (manage or read-only) and replace `devops.example.com`
   with your public host.
2. Visibility: to cover a personal account **and** organisations the App must
   be installable on **"Any account"**; `ALLOWED_ACCOUNTS` then decides which
   installations are accepted. "Only on this account" works for an instance
   that covers a single account.
3. Webhook secret: 32 random bytes (`openssl rand -hex 32`).
4. Setup URL `https://<host>/onboarding` with "Redirect on update" on.
   "Request user authorization (OAuth) during installation" stays off.
5. Note the App id and slug, generate a private key.

### 2. Configure the OIDC provider

Create a confidential OIDC client at your identity provider:

- Redirect URI: `https://<host>/api/auth/callback/oidc`
- Scopes: `openid email profile`, plus `groups` if the provider needs it for
  the groups claim
- Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; the endpoints come
  from `<OIDC_ISSUER>/.well-known/openid-configuration`.

The provider's discovery, token and JWKS endpoints must be reachable from the
app (from Vercel's functions when hosted there).

Only verified emails count for email rules (`OIDC_REQUIRE_VERIFIED_EMAIL=true`).
Do not combine email allowlists with a provider that lets users set
unverified email addresses.

### 3a. Deploy on Vercel Hobby with Neon

1. Create a Neon project (Free) in the region closest to your Vercel region
   (`vercel.json` uses `fra1`; use `aws-eu-central-1` with it).
2. Import the repository in Vercel (from a personal fork or with the Vercel
   CLI; Hobby cannot connect to organisation-owned repositories).
3. Set the environment variables (Project → Settings → Environment
   Variables, environment "Production"), see the table below and
   [`.env.example`](.env.example).
4. Deploy, or redeploy after changing variables: Vercel applies them to new
   deployments only. The build runs
   `prisma generate && next build && prisma migrate deploy`.
5. The daily cron (`17 3 * * *`) calls `/api/cron/reconcile` with
   `Authorization: Bearer $CRON_SECRET`; Vercel sends that header itself once
   `CRON_SECRET` is set.

Environment variables on Vercel. The server refuses to start when a required
one is missing or malformed, and the function log names the variable.

| Variable                                                     | Required                       | Value                                                                                                    |
| ------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                               | yes                            | Neon **pooled** connection string (host with `-pooler`)                                                  |
| `DIRECT_URL`                                                 | yes                            | Neon **direct** connection string (migrations during the build)                                          |
| `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`                     | yes                            | the public URL, e.g. `https://devops.example.com` (no trailing slash)                                    |
| `BETTER_AUTH_SECRET`                                         | yes                            | `openssl rand -base64 48`                                                                                |
| `TOKEN_ENCRYPTION_KEY`                                       | yes                            | `openssl rand -base64 32` (exactly 32 bytes); keep it, stored credentials cannot be decrypted without it |
| `CRON_SECRET`, `AUDIT_IP_SALT`                               | yes                            | `openssl rand -hex 32` each                                                                              |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`        | yes                            | from the OIDC client of step 2                                                                           |
| `ADMIN_EMAILS` or `ADMIN_GROUPS`                             | yes                            | at least one admin rule; `OPERATOR_*` and `VIEWER_*` are optional                                        |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | yes                            | from step 1; the private key as PEM with `\n` escapes or as base64 of the PEM                            |
| `GITHUB_WEBHOOK_SECRET`                                      | yes (except polling-only mode) | the webhook secret of the App                                                                            |
| `ALLOWED_ACCOUNTS`                                           | yes                            | comma-separated GitHub accounts whose installations are accepted, e.g. `example-user,example-org`        |
| `TRUSTED_IP_HEADERS`                                         | no                             | the default `x-forwarded-for` is right on Vercel                                                         |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`           | no                             | only for the optional GitHub login or "Connect GitHub"                                                   |
| `GITHUB_BILLING_TOKEN`, `GITHUB_CONNECT_ENABLED`             | no                             | personal-account billing, see [step 5](#5-optional-personal-account-billing)                             |
| everything else                                              | no                             | the defaults in [`.env.example`](.env.example) work on Vercel                                            |

Vercel Hobby is for non-commercial use only. For company or employer
accounts use Vercel Pro or Docker.

### 3b. Run with Docker Compose

```sh
cp .env.example .env    # fill in the values, including POSTGRES_PASSWORD
docker compose up -d --build
```

This starts `db` (Postgres 17 with a named volume), a one-shot `migrate`, the
`app` on port 3000 and a `cron` sidecar that calls reconcile every
`CRON_INTERVAL_SECONDS` (default 600). The image runs as a non-root user and
exposes `/api/health` (liveness) and `/api/ready` (database and migrations).

Put a reverse proxy with TLS in front of port 3000 (Caddy, Traefik, ...). If
the instance is not reachable from the internet, either use a tunnel for the
webhook endpoint, or run in **polling-only mode**: leave the App webhook
inactive and rely on the cron sidecar (data is slightly staler).

Secrets can be passed as files: every secret accepts `<NAME>_FILE`
(for example `OIDC_CLIENT_SECRET_FILE=/run/secrets/oidc_client_secret`).

### 4. Install the App and sign in

1. Sign in with an account that matches an admin rule.
2. Open **Installations** and click **Install on GitHub**. After installing,
   GitHub redirects back; the installation id is verified with GitHub before it
   is shown.
3. The dashboard lists the repositories of all installations live from GitHub.

### 5. Optional: personal-account billing

Organisations need nothing extra: with the organisation permission
Administration: read, the installation token reads the billing usage report
(organisations on GitHub's enhanced billing platform). For a **personal
account** GitHub answers only to a user token, so without one the costs page
shows estimates and says why. Configure one per personal installation:

- **Option A, token.** Create a fine-grained personal access token of that
  account with the account permission **Plan: read** (no repository access
  needed). Either set it as `GITHUB_BILLING_TOKEN` (applies when the instance
  has exactly one personal installation; never written to the database), or
  store it under **GitHub billing** (`/admin/github`, admin only): the token
  is checked with GitHub, its login must match the account, and it is stored
  encrypted. The page warns 14 days before it expires. Classic tokens
  (`ghp_`) and tokens with OAuth scopes are refused, also in
  `GITHUB_BILLING_TOKEN`: they carry more access than billing needs.
- **Option B, "Connect GitHub".** Set `GITHUB_CONNECT_ENABLED=true`,
  `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`, add the callback
  URL `https://<host>/api/github/connect/callback` to the App, keep "Expire
  user authorization tokens" on and grant the account permission
  **Plan: read**. Then click **Connect GitHub** on `/admin/github` while you
  are signed in on GitHub as that account. Tokens are refreshed
  automatically; if the authorisation is revoked, admins see a reconnect
  notice and costs fall back to estimates. **Remove credential** revokes the
  whole authorisation at GitHub (refresh token included); if GitHub does not
  confirm, nothing is removed and you can retry.

Details, the verified endpoints and the refresh rules are in
[docs/BILLING.md](docs/BILLING.md).

## Sync and freshness

Workflow runs and jobs arrive through the `workflow_run` and `workflow_job`
webhooks and are folded order-independently: duplicate, redelivered or
out-of-order deliveries converge to the same row. `/api/cron/reconcile` repairs
whatever webhooks miss, within a time budget (Vercel: 30 s before the function
deadline; elsewhere 240 s) and with cursors, so the next call resumes:

1. replay deliveries that were recorded but not processed (eight attempts,
   then DEAD),
2. walk GitHub's delivery log for the last 72 hours and request redelivery of
   failed deliveries (oversized ones trigger a resync of the repository),
3. re-read stale queued or running jobs and runs, and placeholder runs,
4. incremental sync of new runs per repository,
5. backfill of `BACKFILL_DAYS` in three-day windows (split further when a
   window holds 1,000 runs or more),
6. runner sampling (online and busy state of every self-hosted runner), with
   a daily discovery of repository and organisation runners,
7. daily rollups, recomputed for every touched day (including runner stats),
8. the daily billing sync (the current month; on days 1 to 3 the previous
   month as well),
9. a daily prune of raw rows older than the retention.

Triggers: the daily Vercel cron, the Docker cron sidecar, a **lazy reconcile**
when an installation page is opened and the last reconcile is older than
`LAZY_RECONCILE_MINUTES`, and **Sync now** (operator or admin, once per five
minutes per installation, audited). Reconcile is idempotent; concurrent
triggers are serialised per installation.

The **Runners** and **Queue** pages also take a runner sample when they are
opened (at most every two minutes per installation) and refresh every 30
seconds, so a STUCK job shows up within one refresh even on Vercel, where the
cron runs only once a day. Utilisation is shown with its sample interval (10
minutes with the Docker sidecar; on Vercel it depends on page views) and as
"insufficient samples" when samples cover less than half of the period.

Every installation page shows a **freshness pill** (age of the last webhook
and the last reconcile) and a stale banner when no webhook arrived for 6 hours
while runs exist, no reconcile ran for 24 hours, or deliveries failed. Admins
find per-repository cursors, backfill progress, last errors, deliveries of the
last 24 hours, ingestion lag and rate limits under the installation's
**Settings**.

**Lean mode** (`LEAN_WEBHOOKS=true`): unsubscribe `workflow_run` in the App
settings to roughly halve webhook invocations on Vercel Hobby. Runs are then
created from their jobs and completed by reconcile.

## Roles

| Role     | May                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer   | read every page of every visible installation, including runners, queue and costs                                                               |
| Operator | everything a viewer may, plus Sync now (M1), re-run and cancel (M3)                                                                             |
| Admin    | everything an operator may, plus variables, merges, installation settings, the billing credential (`/admin/github`) and instance administration |

Roles come from comma-separated, case-insensitive allowlists:
`ADMIN_EMAILS`, `ADMIN_GROUPS`, `OPERATOR_EMAILS`, `OPERATOR_GROUPS`,
`VIEWER_EMAILS`, `VIEWER_GROUPS`. The highest match wins. Users matching no
rule are refused (`DEFAULT_ROLE=none`) or get viewer (`DEFAULT_ROLE=viewer`);
a refused user never gets a user row. `OIDC_ALLOWED_GROUPS` additionally
requires membership in one of the listed groups (GitHub sign-ins carry no
groups and are refused while it is set). The app refuses to start without an
admin rule.

Example: `ADMIN_EMAILS=admin@example.com`, `OPERATOR_GROUPS=devops-operators`,
`VIEWER_GROUPS=devops-viewers`.

Roles are re-evaluated at every sign-in and on every page load; changing the
env takes effect without a new sign-in.

## Configuration

All variables are documented in [`.env.example`](.env.example) and validated
at startup in [`src/env.ts`](src/env.ts). The server refuses to boot without
OIDC settings, an admin rule or `ALLOWED_ACCOUNTS`.

## Development

Requirements: Node 22+, pnpm, Docker (for Postgres).

```sh
pnpm install
docker run -d --name devops-pg -e POSTGRES_USER=devops -e POSTGRES_PASSWORD=devops \
  -e POSTGRES_DB=devops -p 5432:5432 postgres:17
cp .env.example .env    # point DATABASE_URL at the container
pnpm db:migrate:dev
pnpm dev
```

| Command                 | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `pnpm lint`             | ESLint (includes the rule that keeps Prisma inside the data layer)           |
| `pnpm typecheck`        | TypeScript, strict                                                           |
| `pnpm test`             | unit tests                                                                   |
| `pnpm test:integration` | OIDC sign-in against a mock issuer and a real Postgres (`TEST_DATABASE_URL`) |
| `pnpm format:check`     | Prettier                                                                     |
| `pnpm check:privacy`    | personal-data check over tracked files                                       |

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
