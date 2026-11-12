# Setting up the GitHub App

Every deployment registers its own GitHub App. The repository ships two
manifests:

| File                                | Profile                                                                                          | Use with                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `github-app-manifest.json`          | manage: Actions, Contents, Pull requests, Variables and Workflows **write**, Administration read | `MANAGEMENT_ENABLED=true` (default) |
| `github-app-manifest.readonly.json` | read-only, no Workflows                                                                          | `MANAGEMENT_ENABLED=false`          |

Replace every `devops.example.com` with the public host of your instance
before you use a manifest.

The manifests leave out the account permission **Plan**, which only the
optional "Connect GitHub" billing flow (option B, M2) needs. GitHub rejects
unknown permission names in a manifest, so add it after the App exists:
App settings → **Permissions & events** → **Account permissions** →
**Plan: Read-only** → Save. Users who already connected then accept the
new permission once.

## Option A: manifest flow (recommended)

GitHub creates the App from the manifest when it is posted from a form. Save
this as a local HTML file, paste the edited manifest into the hidden field and
open it in a browser while signed in to GitHub:

```html
<!-- For an organisation-owned App use
     https://github.com/organizations/<org>/settings/apps/new -->
<form
  action="https://github.com/settings/apps/new?state=devops-manager"
  method="post"
>
  <input type="hidden" name="manifest" value="PASTE THE MANIFEST JSON HERE" />
  <button type="submit">Create GitHub App</button>
</form>
```

GitHub then redirects to the manifest's `redirect_url` with a one-time `code`.
Exchange it within an hour for the App's credentials:

```sh
curl -X POST -H "Accept: application/vnd.github+json" \
  https://api.github.com/app-manifests/<code>/conversions
```

The response contains `id` (`GITHUB_APP_ID`), `slug` (`GITHUB_APP_SLUG`),
`pem` (`GITHUB_APP_PRIVATE_KEY`), `webhook_secret` (`GITHUB_WEBHOOK_SECRET`),
`client_id` and `client_secret` (`GITHUB_APP_CLIENT_ID` /
`GITHUB_APP_CLIENT_SECRET`, only needed for the optional GitHub flows). Store
them as secrets right away; they are shown once.

A guided `/setup` wizard for this exchange follows in M4.

## Option B: register by hand

Create a new GitHub App in the account or organisation settings and copy the
values of the manifest:

- **Homepage URL**: `https://<host>`
- **Callback URLs**: `https://<host>/api/auth/callback/github` (GitHub login)
  and `https://<host>/api/github/connect/callback` ("Connect GitHub", M2).
  Without either optional flow you can leave them out.
- **Expire user authorization tokens**: on.
- **Request user authorization (OAuth) during installation**: off.
- **Setup URL**: `https://<host>/onboarding`, **Redirect on update**: on.
- **Webhook**: active, URL `https://<host>/api/github/webhook`, secret from
  `openssl rand -hex 32`. Leave it inactive for polling-only mode.
- **Permissions and events**: as listed in the manifest (and in the README's
  permission table).
- **Where can this GitHub App be installed?**: "Any account" to cover a
  personal account and organisations; set `ALLOWED_ACCOUNTS` accordingly.

Then generate a private key and note the App id and slug.

## Private key formats

`GITHUB_APP_PRIVATE_KEY` accepts the PEM as is, the PEM with `\n` escapes
(one line, as most hosting dashboards need it), or the PEM base64-encoded:

```sh
base64 -w0 example-devops-manager.private-key.pem
```

With Docker secrets use `GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github_app_key`.

## Rotating secrets

- **Webhook secret**: set the new one in GitHub and as `GITHUB_WEBHOOK_SECRET`,
  keep the old one as `GITHUB_WEBHOOK_SECRET_PREVIOUS` until no delivery is
  signed with it any more, then remove it.
- **Token encryption key**: set the new key as `TOKEN_ENCRYPTION_KEY` and the
  old one as `TOKEN_ENCRYPTION_KEY_PREVIOUS`; stored values are decrypted with
  either and re-encrypted with the current key.

## Branch rulesets

The App acts as itself (`<slug>[bot]`). Rulesets and branch protection apply
to it like to any actor. If merges by the App should bypass a ruleset, add the
App to the ruleset's bypass list; the app never does this on its own.

## Management

Management actions (re-run and cancel, variables, merges) are performed by the
App with installation tokens narrowed to the action and its target
repositories. Every action is audited with the app user who triggered it.

- `MANAGEMENT_ENABLED=false` is the global kill switch: every action answers
  403 and the instance is read-only. Pair it with the read-only manifest.
- Each installation also has its own toggle, **off by default**. An admin turns
  it on in the installation settings; the change is audited.
- Roles: viewers read, operators re-run and cancel, admins manage variables,
  merge pull requests and change settings. Roles are re-resolved on every
  action, so an allowlist change takes effect immediately.
- `VARIABLE_PRESETS` lists the runs-on switch variables offered for bulk
  changes. The default is `LINUX_RUNNER` (`self-hosted`, `ubuntu-latest`) and
  `MACOS_RUNNER` (`self-hosted`, `macos-latest`) at repository scope. Put
  instance-specific values, such as the label of your own runner pool, in the
  instance env only, for example:

  ```sh
  VARIABLE_PRESETS='[{"name":"LINUX_RUNNER","values":["runner-1","ubuntu-latest"],"scope":"repository"}]'
  ```

  Workflows consume the variable with a fallback:
  `runs-on: ${{ vars.LINUX_RUNNER || 'ubuntu-latest' }}`.

- `MERGE_AUDIT_TRAILER=true` adds `DevOps-Manager-Audit: <auditId>` to merge
  commits, so a merge by the App's bot can be traced to its audit entry
  without putting a user's name or email into the repository. The trailer
  is appended to GitHub's default body (the PR title for a merge commit, the
  squashed commit messages with their `Co-authored-by` lines for a squash).
  A rebase merge writes no merge commit, so it gets no trailer; the audit
  entry records `auditTrailer: false`.
- Variables are not secrets. With the installation's redaction setting on,
  viewers and operators see values masked, and the audit log stores only a
  sha256 and the length, plus a copy sealed with `TOKEN_ENCRYPTION_KEY` so a
  bulk change can still be reverted. Sealed copies stay readable through one
  key rotation (`TOKEN_ENCRYPTION_KEY_PREVIOUS`); batches recorded under an
  older key can no longer be reverted.
- The audit log is hash-chained per installation. **Verify** recomputes the
  chain and reports the first entry that was changed, removed or inserted
  outside the app. Final outcomes are sealed with a result hash; an outcome
  edited back to `PENDING`, a removed result hash or an entry without an
  outcome for over an hour is reported as well. The newest entry of each
  chain is also kept in `AuditChainHead` (a trigger lets it only move
  forward) and logged as `audit chain head`, so removing the newest entries
  is detected. Keep the application logs in an external sink if the head
  should survive a full database rewrite.
