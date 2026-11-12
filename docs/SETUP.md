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
