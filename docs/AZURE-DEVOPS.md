# Azure DevOps (CI: M7 read-only, M7b actions, M7c service principal)

DevOps Manager can show the Azure Pipelines runs of one Azure DevOps
organisation per GitHub installation (account or organisation), next to
GitHub Actions:

- **Pipelines** (`/o/<account>/pipelines`): KPIs, success and duration per
  pipeline, the definition list with the linked GitHub repository.
- **Runs** and the **run detail** with stages, jobs, attempts and live tasks.
- **Usage**: hosted minutes against the free tier, minutes per day, parallel
  jobs, pools and agents.
- Unified views with a source badge: the runs list of the overview and of a
  repository (a **Pipelines** tab), pull request badges, the queue page, the
  costs page (an Azure section and the macOS card) and "Needs attention".

The Workflows and Insights pages stay GitHub-only, and the GitHub tables and
cost computations are unchanged by an Azure connection (an integration test
compares the GitHub cost snapshot byte for byte).

Reading is the default. From M7b, operators can queue, cancel and retry
builds and retry a stage once an admin turned on **Azure actions** (see
"Actions"); nothing else is ever changed in Azure DevOps.

## Connecting

Open the account's **Settings & sync → CI · Azure DevOps** (admin) and click
**Connect Azure DevOps**. Enter the organisation (the name in
`https://dev.azure.com/ORGANISATION`; `ORGANISATION.visualstudio.com` works
too) and choose one credential:

### Personal access token (organisation-scoped)

1. Create a dedicated Azure DevOps user in a dedicated group of the
   organisation (it sees only what the group sees).
2. As that user, create a PAT for **this organisation** (not "All accessible
   organisations") with **Build (Read)**, **Agent Pools (Read)** and
   **Project and Team (Read)**. Optional: **Build (Read & execute)** for the
   actions, **Service Hooks (Read & write)** to let the app create the
   service hook.
3. Paste it and the expiry date. A PAT that is not used for 90 days becomes
   inactive at Microsoft; the regular sync keeps it active.

### Microsoft Entra service principal (recommended by Microsoft)

1. In Microsoft Entra ID, register an application and create a **client
   secret** (certificates are not supported).
2. In Azure DevOps, **Organization settings → Users → Add users**, add the
   service principal by the **Object ID of its Enterprise application** (not
   the application's object id), with the Basic access level, into a
   dedicated group with the permissions above.
3. Enter the tenant id, the client id and the client secret. The app gets
   short-lived tokens with the client credentials flow from
   `login.microsoftonline.com` for the Azure DevOps resource
   `499b84ac-1321-427f-aa17-267ca6975798`. Tokens are cached in memory only.

### What happens on connect

- The credential is validated before anything is stored: the organisation's
  identity call, then one probe per capability (projects, pools, builds of
  each suggested project; the toggle of the actions probes "execute"). A
  missing permission gives a specific error ("Agent Pools: Read is missing");
  a rejected token, Azure DevOps' sign-in page (HTTP 203) or an unknown
  organisation writes nothing.
- The secret (PAT or client secret) is encrypted with
  `TOKEN_ENCRYPTION_KEY`, bound to its row and column, and shown afterwards
  only as its last 4 characters. Key rotation (k2) re-encrypts it together
  with the hook secrets.
- The organisation is stored by its GUID. An organisation can be connected to
  one installation only; connecting it elsewhere fails with "already
  connected elsewhere" and names nothing else.
- Projects with a GitHub-type definition that points at a repository of this
  installation are preselected (at most 20 are probed); the rest can be
  selected by hand. The connect is audited as `ADO_CONNECT` with ids only.

**Rotate credential** replaces the PAT or the service principal of the same
organisation; switching from a PAT to a service principal (or back) keeps the
organisation, the projects and the history. A credential of another
organisation is refused. **Disconnect** (type the organisation name) deletes
every Azure DevOps row of the installation (connection, projects,
definitions, builds, jobs, pools, agents, samples, job requests, usage,
statistics, findings, rate-limit state, hook subscriptions and deliveries,
optionally the service hook subscriptions in Azure DevOps); the audit rows
stay. Revoke the PAT or the client secret as well.

### Environment shortcut

For a single-owner setup, set `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_ACCOUNT` (the
GitHub login whose installation the organisation belongs to) and either
`AZURE_DEVOPS_PAT` (or `AZURE_DEVOPS_PAT_FILE`) or `AZURE_DEVOPS_TENANT_ID`,
`AZURE_DEVOPS_CLIENT_ID` and `AZURE_DEVOPS_CLIENT_SECRET` (or `_FILE`). The
next reconcile pass validates it and creates the connection with the source
"environment"; the credential is never written to the database. A connection
an admin created in the UI is left alone. `ALLOWED_AZURE_ORGS` (names or
GUIDs, comma-separated, `_FILE` capable) limits which organisations may be
connected; unset allows every organisation.

## Freshness

- **Polling** is the baseline: reconcile step "z" runs in the daily cron, in
  the Docker sidecar (every 10 minutes), on Sync now (which also re-reads the
  definitions) and as an 8-second fast path on a page view when the data is
  older than 10 minutes. A full pass has its own 30-second budget (at most 80
  requests) and resumes from its cursors; on Sync now GitHub always keeps at
  least 35 of the 60 seconds. Open builds on a page are refreshed in the
  background (at most 3).
- **GitHub check run hints**: with the App permission **Checks: read** and the
  `check_run` and `check_suite` events (in the shipped manifests; accept the
  updated permissions on the installation), a check run of the Azure
  Pipelines app on a repository of this installation names the build in its
  `details_url`; the app reads that build (at most 3 builds and 3 calls, 5 s,
  debounced to 30 s per build). Only the build id is taken from the event;
  nothing else is stored. Other apps' check runs and ignored repositories are
  skipped. Without the permission the settings page says so and the data
  refreshes by polling.
- **Service hook (optional)**: **Install service hook** creates Web Hooks
  subscriptions (`ms.vss-pipelines.run-state-changed-event`,
  `ms.vss-pipelines.job-state-changed-event`, and `build.complete` as the
  fallback) per selected project with HTTP Basic credentials, or shows the
  URL, user name and password for a manual setup. Deliveries go to
  `/api/azure/hooks/<key>`; the password is compared in constant time, the
  previous one stays valid for 7 days after a rotation, the organisation id
  of the envelope must match, bodies over 256 KB are refused, deliveries are
  deduplicated by notification id, and more than 10 failed deliveries in 5
  minutes block the key for 15 minutes. A delivery only marks the build
  dirty; the build is read from the API. Azure DevOps disables a
  subscription after repeated failures; the sync checks the subscriptions
  every 6 hours and raises "Service hook disabled".

A rejected credential (401, a sign-in page, or a rejected client secret)
stops the sync, shows a banner and a "Needs attention" item, and makes no
further calls until the credential is rotated. `Retry-After` (also on a 200),
a remaining budget below 20 % of `X-RateLimit-Limit`, a 429 or `TF400733`
pause the sync until the reset time.

## Actions (M7b)

| Action         | Role     | Confirmation               | Rule                                                            |
| -------------- | -------- | -------------------------- | --------------------------------------------------------------- |
| Queue run      | operator | dialog with the branch     | linked definitions; a known branch; no template parameters      |
| Cancel         | operator | dialog                     | builds that are not started, postponed or in progress           |
| Retry build    | operator | dialog                     | completed builds that failed, partly succeeded or were canceled |
| Retry stage    | operator | dialog with the stage      | a failed or canceled stage of a completed build                 |
| Azure actions  | admin    | type the organisation name | the switch itself; off by default; runs an execute probe first  |
| Quota blocking | admin    | limits form                | refuses queue and retry while the free minutes are used up      |

- **Three switches**: `MANAGEMENT_ENABLED` and `AZURE_MANAGEMENT_ENABLED`
  (env), the account's management switch, and **Azure actions** in the
  connection's settings. Turning Azure actions on first runs an execute probe
  (`previewRun: true` on one linked definition: the YAML is expanded, nothing
  starts). If it fails, the switch stays off and "execute" shows as missing.
  With any switch off, a rejected credential, a missing execute permission or
  a paused rate budget, an action answers "unavailable" with the reason and
  the attempt is recorded as DENIED; viewers get "forbidden", also recorded.
- **Free tier**: a queue or retry that may exceed the free minutes or the
  60-minute job limit shows a warning; it does not block unless an admin
  turned on blocking.
- **Audit**: every action is one entry in the installation's hash-chained
  audit log, performed as `azure:pat:<last 4>`, `azure:sp:<last 4>` or
  `azure:env-token`, with Azure DevOps' status, message and
  `ActivityId`. Parameters are ids only (project GUID, definition id, build
  id, stage identifier, branch ref).
- **Unknown outcomes**: a queued build is tagged `dm-audit-<audit id>`. If a
  request fails after it was sent, the entry is "outcome unknown"; the next
  sync links the build to the entry (exact through the tag, or "probably" by
  definition, branch and a 2-minute window). The entry itself is never
  changed.
- **Log excerpt**: operators and admins can show the last 200 lines (at most
  64 KB) of a job's log. It is read live, the credential, the organisation
  name and token patterns are removed, shown as plain text and never stored
  or logged. Viewers get the link to Azure DevOps.

## What is stored

| Data                 | Fields                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection           | organisation GUID and name, credential kind, the encrypted PAT or client secret and its last 4 characters, tenant and client id of a service principal, expiry, capability probe results, limits, sync status, the last error (redacted), hook key and secrets |
| Projects             | GUID, name, visibility, selection, cursors                                                                                                                                                                                                                     |
| Pipeline definitions | id, name, path, repository type, the linked GitHub repository of this installation, default branch, OS override                                                                                                                                                |
| Builds               | id, number, definition, status, result, reason, branch, commit SHA, PR number, times, attempts and the first attempt's result, job-cap and timeout flags, the audit link of a queued build; kept for the installation's raw retention                          |
| Jobs and stages      | record id, attempt, name, result, times, worker kind (hosted or self-hosted), OS, queue time, issue counts                                                                                                                                                     |
| Pools and agents     | id, name, hosted flag, size; agent name, status and enabled flag; samples of busy and idle agents                                                                                                                                                              |
| Job requests         | request id, pool, project, definition, times, result, OS (org-wide, used for the minutes)                                                                                                                                                                      |
| Daily statistics     | per definition and day: counts by result, first-try success, flaky recovered, duration and queue histograms; per day: hosted minutes (private, public, per OS), peak parallel jobs, saturated time                                                             |
| Findings             | default branch failing, job near the time cap, definition not linked, minutes at 80 % and 100 %, parallel jobs saturated, self-hosted pool offline, service hook disabled, credential rejected or expiring                                                     |

Never read or stored: identities (`requestedFor`, `requestedBy`,
`lastChangedBy`, `authenticatedUser`, pool owners), user names and e-mail
addresses, build logs (the excerpt is read live and discarded), variables,
template parameters, artifacts, `_links`. The client drops every field it
does not need at the boundary (zod allowlists). Organisation and project
names are tenant data: they are stored for URLs and display but never
written to logs, errors or audit parameters.

A definition's repository link is resolved only to a repository of **the
same installation** that is neither removed nor ignored. Admins can link a
definition by hand, with the same rule. Builds of definitions that are not
linked are not stored; their minutes still count (job requests are
org-wide).

The app roles are the only authorisation layer: Azure DevOps permissions are
not mapped, every user sees the organisation through the one credential,
limited by their role in DevOps Manager.

Outbound hosts: `dev.azure.com` and, for a service principal,
`login.microsoftonline.com` (both fixed in code). Links to Azure DevOps are
built from stored ids.

## API facts (from the Microsoft docs, 2026-11)

Base URL `https://dev.azure.com/{organization}`, `api-version=7.1` unless
noted. A PAT is sent as `Authorization: Basic base64(":" + PAT)`, a service
principal token as `Bearer`. Every request sends
`X-TFS-FedAuthRedirect: Suppress`, so an invalid credential answers 401
instead of a 203 sign-in page; a 203 or an HTML answer still counts as a
rejected credential. Redirects are not followed.

| Call                                                                            | Use                    | Notes                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /_apis/connectionData`                                                     | organisation identity  | `instanceId` is the organisation GUID; `authenticatedUser` is dropped (see M7.0)                                                                                                                                                       |
| `GET /_apis/projects?$top=&continuationToken=`                                  | projects               | `id`, `name`, `visibility` (`private`, `public`), `state`; paged by the `x-ms-continuationtoken` header                                                                                                                                |
| `GET {project}/_apis/build/definitions?includeAllProperties=true`               | definitions            | `repository.type` (`GitHub`, `TfsGit`, …) and `repository.id`/`name` (`owner/repo` for GitHub), `path`, `queueStatus`                                                                                                                  |
| `GET {project}/_apis/build/builds?minTime=&queryOrder=queueTimeAscending&$top=` | new and open builds    | `statusFilter` (`notStarted`, `inProgress`, `completed`, `cancelling`, `postponed`, `all`), `buildIds=`, `definitions=`; `status`, `result` (`succeeded`, `partiallySucceeded`, `failed`, `canceled`, `none`), `reason`, `triggerInfo` |
| `GET {project}/_apis/build/builds/{id}/timeline`                                | stages, jobs, attempts | records with `type` (`Stage`, `Phase`, `Job`, `Task`), `attempt`, `previousAttempts[{attempt, timelineId}]`, `state`, `result`, `workerName`, `issues`, `log.id`; `…/timeline/{timelineId}` reads an earlier attempt                   |
| `GET /_apis/distributedtask/pools`, `…/pools/{id}/agents`                       | pools and agents       | `isHosted`, `size`; agent `status` (`online`, `offline`), `enabled`                                                                                                                                                                    |
| `GET /_apis/distributedtask/pools/{id}/jobrequests` (`7.1-preview.1`)           | minutes, queue time    | `queueTime`, `assignTime`, `finishTime`, `result`, `scopeId` (project), `definition`, `jobId`, `agentSpecification`; `owner` is dropped                                                                                                |
| `GET /_apis/distributedtask/resourceusage` (`7.2-preview.1`)                    | parallel jobs, minutes | `resourceLimit.{totalCount, totalMinutes, isPremium, isHosted}`, `usedCount`, `usedMinutes`; a 404 or another shape falls back to the estimate                                                                                         |
| `GET {project}/_apis/build/builds/{id}/logs/{logId}?startLine=`                 | log excerpt            | plain text                                                                                                                                                                                                                             |
| `POST {project}/_apis/pipelines/{id}/runs`                                      | queue, execute probe   | body `{ resources: { repositories: { self: { refName } } }, previewRun? }`; `previewRun: true` expands the YAML and starts nothing                                                                                                     |
| `PATCH {project}/_apis/build/builds/{id}`                                       | cancel, retry          | cancel: `{ status: "cancelling" }`; retry: `?retry=true` with an empty body (reruns failed jobs as attempt + 1)                                                                                                                        |
| `PATCH {project}/_apis/build/builds/{id}/stages/{stageRefName}`                 | stage retry            | `{ state: "retry", forceRetryAllJobs: false }` (`7.1`)                                                                                                                                                                                 |
| `PUT {project}/_apis/build/builds/{id}/tags/{tag}`                              | audit tag              | `dm-audit-<uuid>`                                                                                                                                                                                                                      |
| `GET/POST/DELETE /_apis/hooks/subscriptions`                                    | service hook           | consumer `webHooks`, action `httpRequest`; publisher `pipelines` (run and job state events) or `tfs` (`build.complete`); `resourceDetailsToSend: minimal`, `messagesToSend: none`; `status` (`enabled`, `disabledBySystem`, …)         |

Rate limits: Azure DevOps meters requests in TSTUs (200 per user in a sliding
5-minute window). Responses carry `X-RateLimit-Resource`, `-Delay`, `-Limit`,
`-Remaining` and `-Reset` once a caller is delayed, and `Retry-After` when it
should stop, also on a 200. A blocked request answers 429, or an error with
`TF400733`.

Service principals: the token comes from
`POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with
`grant_type=client_credentials` and the scope
`499b84ac-1321-427f-aa17-267ca6975798/.default`. Invalid client secrets
answer `invalid_client` (AADSTS7000215); the app treats that as a rejected
credential.

PATs: new PATs are 84 characters long and carry the `AZDO` signature at
positions 76 to 80; older ones are 52 characters in base32. A PAT unused for
90 days becomes inactive. `scripts/check-personal-data.mjs` flags both
formats in the repository.

Free tier (Microsoft-hosted): 1,800 minutes per month and one parallel job
for private projects, jobs end after 60 minutes; a paid parallel job removes
the monthly limit and allows 360-minute jobs. Public projects have their own
free grant, which Microsoft is retiring for new organisations (planned for
2027); the app counts public minutes separately and never against the
private grant. The month is assumed to reset on the first (configurable in
the limits).

## Open items of the M7.0 probe

The verification spike against a live organisation was not run. Every item
below has a fallback that is implemented and tested against the fake API
(`test/integration/support/azure-devops.ts`); a probe should confirm them:

| Item                                                                  | Assumption                                                                      | Fallback when it differs                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `connectionData` returns the organisation GUID                        | `instanceId`                                                                    | the organisation is stored by `name:<organisation>`; a later pass replaces it once the GUID is known                      |
| `owner/repo` of a GitHub definition                                   | `repository.id` or `repository.name`                                            | the admin links the definition by hand                                                                                    |
| Continuation header and `lastChangedDate`                             | `x-ms-continuationtoken`; cursor on queue time with overlap                     | the cursor moves only on a complete chain; the 30-minute sweep of completed builds catches late changes                   |
| Job requests: `jobId` equals the timeline record id, OS fields        | `agentSpecification.VMImage`, pool name                                         | the OS comes from the worker name or the definition's OS override; without job requests the usage is estimated (labelled) |
| `resourceusage` scope and shape                                       | org-wide, `7.2-preview.1`                                                       | the limits are entered by hand; usage is the estimate                                                                     |
| Minutes rounded per job                                               | rounded up per job                                                              | the estimate notes a difference over 5 % against the API value                                                            |
| Job-cap issue text                                                    | contains "maximum execution time" or "ran longer than the maximum time"         | the cap is also derived from the duration and the job limit                                                               |
| Tag writes on a queued build                                          | allowed with Build (Read & execute)                                             | the "probably" link by definition, branch and time                                                                        |
| Cancel, retry and stage-retry semantics                               | see the table above                                                             | the build is re-read after every action; the page shows what Azure DevOps reports                                         |
| Hook consumer input names                                             | `basicAuthUsername`, `basicAuthPassword` (the docs list `basicAuthCredentials`) | the manual setup shows URL, user name and password to enter in Azure DevOps                                               |
| Envelope container ids                                                | `resourceContainers.account.id` is the organisation GUID                        | a delivery without a matching id is refused; polling continues                                                            |
| `check_run` events of the Azure Pipelines app reach a third-party app | delivered; `details_url` carries `buildId=`                                     | `check_suite` events, then the service hook, then polling                                                                 |

The probe should print shapes only (key paths, types, header names, status
codes), never values, and its output must not be committed.
