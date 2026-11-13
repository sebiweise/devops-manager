# Vercel (hosting: M5 read-only, M6 actions)

DevOps Manager can show the projects and deployments of one Vercel team per
GitHub installation (account or organisation): a Deployments page, a
Projects page, a Deployments card on the repository page, preview badges on
pull requests and runs, a Hosting card with "Needs attention" on the
overview and the dashboard. Reading is GET only (the read client cannot
send anything else; a unit test checks it). From M6, operators can
redeploy, cancel, promote and roll back deployments once an admin turned on
**Vercel actions** (see "Actions"); nothing else is ever changed at Vercel.

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
  targeted refresh (at most 3 projects, debounced to 30 s per project) reads
  their deployments from Vercel; a project whose production deployment
  became ready is read once more, so a production pinned by a rollback keeps
  its "auto-assign paused" banner. Nothing from the event payload is stored.
  Without the permission the settings page says so and the data refreshes by
  polling.

A rejected token (401, or 403 with `invalidToken`/`missingToken`) stops the
sync, shows a banner and a "Needs attention" item, and makes no further calls
until the token is rotated. A 429 pauses the sync until its retry time. Both
apply to every read: the sync, the hint refresh and the build log. An action
whose token is rejected revokes the connection too; a 429 on an action does
not pause the sync (write limits are per action).

## Actions (M6)

| Action         | Role     | Confirmation                                         | Rule                                                              |
| -------------- | -------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Redeploy       | operator | dialog (preview), type the project name (production) | finished deployments; optional "use the latest commit"            |
| Cancel         | operator | dialog                                               | queued or building deployments                                    |
| Promote        | operator | type the project name                                | ready production deployments; no new build                        |
| Roll back      | operator | type the project name                                | candidates only; on Hobby only the previous production deployment |
| Vercel actions | admin    | type the team slug                                   | the switch itself; off by default                                 |

- **Three switches**: `MANAGEMENT_ENABLED`, the account's management switch
  and **Vercel actions** in **Settings & sync → Hosting · Vercel**. With any
  of them off, or a rejected token, an action answers "unavailable" and the
  attempt is recorded as DENIED; viewers get "forbidden", also recorded.
- **Audit**: every action is one entry in the installation's hash-chained
  audit log, performed as `vercel:token:<last 4>` (or `vercel:env-token`),
  with Vercel's status, message and `x-vercel-id`. Parameters are ids and
  flags only. A double submit (same dialog) sends one request.
- **Re-read**: after each call the deployment (or the project) is read from
  Vercel again and stored; the page shows what Vercel reported. When that
  read fails after Vercel accepted the call, the entry still records the
  call's result; a promote or rollback then records the request on the
  project (a rollback shows the banner at once) and the next sync reads the
  serving deployment.
- **Auto-assign paused (rollback)**: after a rollback Vercel stops assigning
  the production domains to new deployments. The repository card, the
  project row and "Needs attention" show a banner with **Promote** for the
  newest ready production deployment; promoting turns auto-assignment on
  again.
- **Unknown outcomes**: a redeploy carries its audit entry's id in
  `meta.devopsManagerAudit`. If the request fails after it was sent, the
  entry is "outcome unknown"; the next sync links the deployment it created
  to the entry (exact through `meta`, or "probably" by project, creator
  kind and a 2-minute window). The entry itself is never changed.
- **Build log excerpt**: operators and admins can show the newest 200 lines
  of a deployment's build output in the expanded row. It is read live from
  Vercel, the token and token patterns are removed, it is capped at 256 KB,
  shown as plain text and never stored or logged. Viewers get the link to
  Vercel.

## What is stored

| Data                   | Fields                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection             | team id, slug and name, plan, token source, the encrypted token and its last 4 characters, token scope (team or full) and expiry, sync status, the last error (redacted)                                                                                                                                                                        |
| Projects               | id, name, framework, Git link type, linked GitHub repository id and name, production branch, the deployment serving production, the derived "auto-assign paused" state, the last promote or rollback request (type, job status, time, target) read after an action                                                                              |
| Deployments            | id, project, target, state, hostname, branch, commit SHA, the first line of the commit message (200 characters), creator **kind** (git, cli, api, redeploy), error code, build time, the audit entry of a redeploy (exact or probable); kept for the installation's raw retention (latest production and latest preview per branch always stay) |
| Daily deployment stats | per project, day and target: counts by state, build time p50/p90                                                                                                                                                                                                                                                                                |
| Findings               | failing production, auto-assign paused, token expiring or rejected                                                                                                                                                                                                                                                                              |

Never read or stored: environment variable values (project lists contain an
`env` array; it is dropped at the client boundary, and a `decrypt` parameter
is refused), Vercel user names, logins, e-mail addresses and avatars, deploy
hook URLs, build and runtime logs (the M6 build log excerpt is read live,
scrubbed and discarded).

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

### M6 calls (verified against the Vercel REST docs, 2026-11)

| Call                                                                    | Use                    | Notes                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v13/deployments?forceNew=1`                                      | redeploy               | body `{ name, deploymentId, target?, withLatestCommit?, meta }`; `name` is required; with `deploymentId` all settings are inherited; `target` omitted means preview; `withLatestCommit` drops the old SHA; `meta` values are strings (`devopsManagerAudit`) and come back in deployment reads |
| `PATCH /v12/deployments/{id}/cancel`                                    | cancel                 | 400 when the deployment is no longer cancelable (READY, ERROR, CANCELED); returns the deployment with `readyState: CANCELED`                                                                                                                                                                  |
| `POST /v10/projects/{projectId}/promote/{deploymentId}`                 | promote                | no rebuild; 201 or 202 without a documented body; re-enables auto-assignment of production domains                                                                                                                                                                                            |
| `POST /v1/projects/{projectId}/rollback/{deploymentId}`                 | rollback               | 201; Hobby may roll back to the previous production deployment only (Pro: any deployment once aliased to production); turns auto-assignment off; 409 while another promote or rollback job runs                                                                                               |
| `GET /v9/projects/{id}?rollbackInfo=true`                               | re-read after an alias | `lastAliasRequest.{type (promote, rollback), jobStatus (pending, in-progress, succeeded, failed, skipped), requestedAt, toDeploymentId}`, null without `rollbackInfo` and in `GET /v10/projects`; `targets.production.id` is the serving deployment; re-read up to 3 times while the job runs |
| `GET /v3/deployments/{id}/events?follow=0&direction=backward&limit=200` | build log excerpt      | an array of events; build output in `type` command, stdout, stderr, exit, fatal with `payload.text` (or `text`); other types are skipped                                                                                                                                                      |

The `GET /v1/projects/{projectId}/promote/aliases` (alias
status of the last promote) is not used: the project read above answers
whether the job finished.
