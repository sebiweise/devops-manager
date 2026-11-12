# Costs, billing sync and the personal billing credential

DevOps Manager shows Actions costs from two sources:

- **Billed**: GitHub's enhanced billing usage report, synced once a day per
  installation (reconcile step h) into `BillingUsageItem`. The current month
  is synced every day, the previous month as well on days 1 to 3.
- **Estimated**: job durations × the `SkuRate` table (rounded up to whole
  minutes per job, free for public repositories on standard hosted runners
  and for self-hosted runners). Rates are read at query time, so editing a
  rate changes the estimates without a deploy.

Without billed data the costs page shows estimates only, with the reason
(`no_permission`, `no_credential`, `unavailable`, `credential_error` or
`not_synced`).

## Endpoints (verified against the GitHub REST docs, 2026-11)

| Account      | Endpoint                                          | Credential                                                     | Permission                            |
| ------------ | ------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------- |
| Organisation | `GET /organizations/{org}/settings/billing/usage` | installation token (`sync.billing`) or user token              | Organization **Administration: read** |
| Personal     | `GET /users/{username}/settings/billing/usage`    | **user** token only (fine-grained PAT or user-to-server token) | Account **Plan: read**                |

Notes from the docs:

- The GitHub App permission tables list the org endpoint for user access
  tokens and installation access tokens, the user endpoint for **user access
  tokens only**. That is why personal accounts need the optional credential.
- The fine-grained PAT tables list the org endpoint under organisation
  "Administration" (read) and the user endpoint under account "Plan" (read).
- The org report is only available to organisations on the enhanced billing
  platform. Without it GitHub refuses the call; the app records
  `unavailable` and shows estimates.
- Query parameters: `year`, `month` (1-12) and `day`; no pagination is
  documented. The app requests one month at a time.
- Response: `{ "usageItems": [ ... ] }`. Each item has `date`, `product`,
  `sku`, `quantity`, `unitType`, `pricePerUnit`, `grossAmount`,
  `discountAmount`, `netAmount` and an optional `repositoryName`; the org
  report also has `organizationName`. Numbers are parsed as decimals; items
  that do not match the schema are skipped and counted.

Mapping to the estimates: billing SKUs such as `Actions Linux` or
`Actions macOS 3-core` are mapped to the `SkuRate` keys (`linux`, `macos`,
`linux_4_core`, ...). "Used vs included" counts minute SKUs as
`quantity × minuteMultiplier`. Whether `quantity` is raw or already
multiplied still has to be confirmed against a real response (design §14,
question 11); estimate vs billed is compared on gross USD, which does not
depend on that.

## Personal billing credential

Option A and option B are configured per personal installation by an admin.
Both credentials are used **only** for the billing step and are stored
encrypted with the instance key ring (`TOKEN_ENCRYPTION_KEY`), bound to their
row and column. They never appear in logs or audit parameters.

### Option A: token

- Either set `GITHUB_BILLING_TOKEN` (or `GITHUB_BILLING_TOKEN_FILE`). It
  applies only when the instance has exactly one personal installation and
  is never written to the database. Startup validation accepts only a
  fine-grained PAT (`github_pat_...`).
- Or store a token through the admin Server Action (`/admin/github`): a
  fine-grained personal access token of that account with the account
  permission **Plan: read**. The token is validated with `GET /user`; its
  login must equal the installation's account, and the account login must
  be typed as confirmation. The expiry GitHub reports for the token is
  stored, and the status warns 14 days ahead.
- Only fine-grained PATs are accepted: a classic token (`ghp_`), an OAuth
  token (`gho_`) or any token whose `GET /user` answer carries a non-empty
  `x-oauth-scopes` header is refused as "token too broad", so the stored
  secret cannot do more than read billing.

### Option B: "Connect GitHub"

Needs `GITHUB_CONNECT_ENABLED=true`, `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET`, the callback URL
`<BETTER_AUTH_URL>/api/github/connect/callback` in the App settings,
"Expire user authorization tokens" on, and the account permission
**Plan: read** in the App.

1. The admin starts the flow. The app stores a one-time state (hashed key,
   bound to that admin and the installation, 10 minutes) and the PKCE
   verifier (encrypted), and returns GitHub's authorize URL
   (`code_challenge_method=S256`, `login` preset to the account).
2. The account owner authorises the App on GitHub; GitHub redirects to the
   callback with `code` and `state`.
3. The callback checks the state against the signed-in admin, exchanges the
   code with the verifier at `POST https://github.com/login/oauth/access_token`,
   and reads `GET /user`. A different login is rejected and its token
   revoked again.
4. The user-to-server token (8 h) and refresh token (6 months) are stored
   encrypted.

Refresh: when the access token expires within five minutes, the billing step
refreshes it (`grant_type=refresh_token`). GitHub invalidates the used
refresh token and the old access token, so the refresh runs while the
credential row is locked and the new pair is written in the same
transaction; a concurrent caller waits and uses the new token.

A rejected refresh token, an expired refresh token or a
`github_app_authorization.revoked` webhook wipes the tokens and marks the
credential "reconnect required"; admins see a reconnect notice and costs fall
back to estimates.

Revoke and replace: removing a connected credential revokes the whole
authorisation with `DELETE /applications/{client_id}/grant` (Basic auth with
the App's client id and secret, body `{access_token}`), which ends every
access and refresh token of that user for the App. The grant endpoint needs
a valid access token, and the stored one has usually expired (8 h, refreshed
only by the daily billing step), so the app first refreshes it while the row
is locked and persists the rotated pair. Outcomes:

- GitHub confirms, or no token of the credential is usable any more
  (expired or rejected refresh token, 404): the row is deleted, audit
  SUCCEEDED.
- GitHub refuses or cannot be reached: the row stays with a usable token so
  the removal can be retried ("revoke failed", audit FAILED). Revoking the
  App under GitHub Settings > Applications also works; the
  `github_app_authorization.revoked` webhook then wipes the tokens and the
  removal succeeds.
- `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET` missing: the row is
  deleted, but the result is "removed here only" and the audit row is FAILED.

Storing a PAT over a connected credential revokes the grant first (and
stores nothing if that fails). "Reconnect" as the same GitHub user revokes
only the old token pair (`DELETE /applications/{client_id}/token`), because
the new token belongs to the same grant; connecting another user revokes the
old user's grant. The outcome is recorded as `previousRevocation` in the
audit parameters. A Connect attempt with the wrong account gives that
account's grant back right away.
