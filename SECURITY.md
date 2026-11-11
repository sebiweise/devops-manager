# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Security" tab of this repository, "Report a vulnerability"). Do not open a
public issue.

Include what you found, how to reproduce it and the impact you expect. You
will get an acknowledgement within a week. Fixes are released as soon as
possible, and the advisory is published once a fixed version is available.
Credit is given unless you prefer otherwise.

## Supported versions

Until v1.0, only the latest release receives security fixes.

## Threat model (summary)

**Assets**: the GitHub App private key and installation tokens (which can
re-run workflows, change variables and merge pull requests), the OIDC client
secret, session cookies, the stored run history and the audit log.

**Trust boundaries and controls**

| Boundary                | Threat                                 | Control                                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub → webhook        | forged or replayed deliveries          | HMAC-SHA256 over the raw body with constant-time comparison, secret rotation, delivery-id dedupe, event allowlist, 4 MB cap, installation and repository consistency check (mismatches are quarantined), payloads dropped after processing |
| Browser → app           | session theft, CSRF, XSS, clickjacking | `__Host-` HttpOnly SameSite=Lax cookies over https, Origin checks, nonce-based CSP, `frame-ancestors 'none'`, GitHub-provided text rendered as text only                                                                                   |
| Identity provider → app | token forgery, account takeover        | authorization code flow with PKCE, state and nonce; ID token verified against the issuer's JWKS; email rules only for verified emails; no implicit account linking; no self-registration                                                   |
| App users               | privilege escalation                   | app roles re-resolved from env and DB on every request; env roles act as a floor; role, groups and override fields cannot be written through auth endpoints                                                                                |
| App → GitHub            | over-privileged tokens                 | one GitHub App as the only credential; installation tokens narrowed per purpose and repository, memory only, mutation tokens never cached                                                                                                  |
| Installations           | cross-tenant access                    | every query takes a `TenantScope`; unknown or invisible accounts answer 404; installations outside `ALLOWED_ACCOUNTS` are never stored                                                                                                     |
| Database                | credential leaks                       | provider tokens are not stored; any stored token is AES-256-GCM encrypted with a rotatable key ring                                                                                                                                        |

**Known limits**

- Because GitHub sees only the App, a compromised operator or admin account
  can do on every installation what that role allows. Management is off by
  default per installation (M3), and the read-only manifest is available.
- An identity provider that lets users choose unverified email addresses must
  not be combined with email allowlists.
- The app trusts the configured OIDC issuer for group claims.

## Dependencies and supply chain

Dependabot (with a cooldown), Semgrep, Trivy and Gitleaks run in CI. Actions
are pinned by commit SHA and run on GitHub-hosted runners only.
