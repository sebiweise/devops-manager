# Vercel (hosting, M5: read-only)

DevOps Manager can show the projects and deployments of one Vercel team per
GitHub installation (account or organisation): a Deployments page, a
Projects page, a Deployments card on the repository page, preview badges on
pull requests and runs, a Hosting card with "Needs attention" on the
overview and the dashboard. M5 is **read-only**: the app sends GET requests
only (a unit test checks it) and changes nothing at Vercel.

## Connecting

1. In Vercel, open **Account settings → Tokens** and create a token. Set its
   **scope to the team** and give it an **expiry**.
2. In DevOps Manager, open the account's **Settings & sync → Hosting ·
   Vercel** (admin) and click **Connect Vercel**. Paste the token. The team
   id (`team_…`) is only needed for a full-account token that reaches several
   teams; such tokens reach every team of the user, so a team-scoped token is
   preferred.
3. The token is validated before anything is stored (see "API facts"),
   encrypted with `TOKEN_ENCRYPTION_KEY` (bound to its row and column) and
   shown afterwards only as its last 4 characters. The connect is audited as
   `VERCEL_CONNECT` in the installation's audit chain, without the token.
   The first sync starts right away.

**Rotate token** replaces the token of the same team (a token of another
team is refused). **Disconnect** (type the team slug) deletes the stored
projects, deployments, statistics and findings; the audit rows stay. Revoke
the token at Vercel as well; the app does not call the token-delete API.

### Environment shortcut

For a single-owner setup, set `VERCEL_TOKEN` (or `VERCEL_TOKEN_FILE`),
`VERCEL_ACCOUNT` (the GitHub login whose installation the team belongs to)
and, for a full-account token, `VERCEL_TEAM_ID`. The next reconcile pass
validates the token and creates the connection with the source "environment";
the token is never written to the database. A connection an admin created in
the UI is left alone. `ALLOWED_VERCEL_TEAMS` (ids or slugs, comma-separated,
`_FILE` capable) limits which teams may be connected; unset allows every team.

A team can be connected to one installation only; connecting it elsewhere
fails with "already connected elsewhere" and names nothing else.

## Freshness

- **Polling** is the baseline: reconcile step "v" runs in the daily cron, in
  the Docker sidecar (every 10 minutes), on Sync now (which also re-reads the
  project list) and as a 20-second fast path on a page view when the data is
  older than 5 minutes. Each pass has its own 25-second budget and resumes
  from its cursor.
- **GitHub deployment hints**: with the App permission **Deployments: read**
  and the `deployment_status` event (both in the shipped manifests; accept
  the updated permissions on the installation), the Vercel GitHub integration's
  deployment events mark the projects linked to that repository dirty, and a
  targeted refresh (at most 3 GETs, debounced to 30 s per project) reads their
  state from Vercel. Nothing from the event payload is stored. Without the
  permission the settings page says so and the data refreshes by polling.

A rejected token (401, or 403 with `invalidToken`/`missingToken`) stops the
sync, shows a banner and a "Needs attention" item, and makes no further calls
until the token is rotated. A 429 pauses the sync until its retry time.

## What is stored

| Data                   | Fields                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection             | team id, slug and name, plan, token source, the encrypted token and its last 4 characters, token scope (team or full) and expiry, sync status, the last error (redacted)                                                                                                                     |
| Projects               | id, name, framework, Git link type, linked GitHub repository id and name, production branch, the deployment serving production, the derived "auto-assign paused" state                                                                                                                       |
| Deployments            | id, project, target, state, hostname, branch, commit SHA, the first line of the commit message (200 characters), creator **kind** (git, cli, api, redeploy), error code, build time; kept for the installation's raw retention (latest production and latest preview per branch always stay) |
| Daily deployment stats | per project, day and target: counts by state, build time p50/p90                                                                                                                                                                                                                             |
| Findings               | failing production, auto-assign paused, token expiring or rejected                                                                                                                                                                                                                           |

Never read or stored: environment variable values (project lists contain an
`env` array; it is dropped at the client boundary, and a `decrypt` parameter
is refused), Vercel user names, logins, e-mail addresses and avatars, deploy
hook URLs, build and runtime logs.

A project's repository link is resolved only to a repository of **the same
installation** that is neither removed nor ignored. Admins can link CLI-deployed
projects by hand (`VERCEL_PROJECT_LINK`, audited), with the same rule.

The app roles are the only authorisation layer: Vercel's own team roles are
not mapped, every user sees the team through the one token, limited by their
role in DevOps Manager. Viewers see the data but cannot connect.

Outbound host: `api.vercel.com` only (fixed in code, not configurable).
Links to `vercel.com` are built from stored ids.

## API facts (verified against the Vercel REST docs, 2026-11)

Base URL `https://api.vercel.com`, `Authorization: Bearer <token>`; team
resources take `?teamId=`.

| Call                                          | Use                                   | Notes                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v2/user`                                | token check                           | `{ user: { id, defaultTeamId, … } }`; tokens without full user privileges get a `limited` user                                                                                                                                                                                                                                                                           |
| `GET /v5/user/tokens/current`                 | scopes and expiry                     | `token.expiresAt` (ms), `token.scopes[]` with `type` (`user` or `team`) and `teamId`; a 403/404 means "unknown", not "invalid"                                                                                                                                                                                                                                           |
| `GET /v2/teams/{teamId}`                      | team                                  | `id`, `slug`, `name`, `billing.plan` (`hobby`, `pro`, `enterprise`)                                                                                                                                                                                                                                                                                                      |
| `GET /v2/teams`                               | the only team of a full-account token | `teams[]`, `pagination.next`                                                                                                                                                                                                                                                                                                                                             |
| `GET /v10/projects?limit=100&from=`           | projects                              | paginated by `pagination.next` passed as `from` (a timestamp or continuation token); `link.{type, org, repo, repoId, productionBranch}`, `targets.production.id`; the response also carries `env[]` with values, which the client drops                                                                                                                                  |
| `GET /v7/deployments?since=&until=&limit=100` | deployments, newest first             | `pagination.next` is the timestamp to pass as `until` for the next page; `uid`, `projectId`, `name`, `url` (hostname), `createdAt`, `buildingAt`, `ready`, `readyState`, `readySubstate`, `target` (`production`, `staging` or null = preview), `source`, `errorCode`, `isRollbackCandidate`, `meta.githubCommitSha/Ref/Message`; `creator.username`/`email` are dropped |
| `GET /v13/deployments/{id}`                   | refresh of a non-terminal deployment  | `id` instead of `uid`; `gitSource.sha/ref` only with `withGitRepoInfo=true` (not used: `meta` carries the commit)                                                                                                                                                                                                                                                        |

States: `QUEUED`, `INITIALIZING`, `BUILDING`, `READY`, `ERROR`, `CANCELED`,
`BLOCKED`, `DELETED`; anything else is stored as `UNKNOWN`, and a deployment
still building after 6 hours becomes `UNKNOWN`. `source` (git, cli, redeploy,
api-trigger-git-deploy, git-deploy-hook, …) is "best effort" per the docs and
only used for the creator kind.

Errors: `{ error: { code, message } }`; `forbidden` with `invalidToken: true`
marks a rejected token. Rate limits are per endpoint; a 429 body carries
`error.limit.{remaining, reset, resetMs, total}`, and the retry time is
`resetMs`, then `retry-after`, then now + 60 s. The client also records
`x-ratelimit-limit`/`-remaining`/`-reset` when sent (the design does not
depend on them) and `x-vercel-id` as the request id.

Plan limits shown in the app (static, from the Limits page): deployments
created per day 100 (Hobby) and 6000 (Pro), in a 86 400 s window; the
"Deploys in 24 h" tile counts the last 24 hours.
