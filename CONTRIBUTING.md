# Contributing

Thanks for helping. Bug reports, ideas and pull requests are welcome.

## Before you start

- For larger changes, open an issue first so the approach can be agreed on.
- Security issues: do **not** open a public issue, see [SECURITY.md](SECURITY.md).

## Development setup

See [README.md#development](README.md#development). In short: Node 22+, pnpm,
a local Postgres, `pnpm install`, `pnpm db:migrate:dev`, `pnpm dev`.

## Local demo with synthetic data

For UI work and screenshots there is a demo setup that needs no GitHub App
and no real identity provider. It is for local use only: both scripts refuse
to run with `NODE_ENV=production`, the seed refuses any database that is not
on `localhost`/`127.0.0.1`, the mock issuer binds to `127.0.0.1` only, and
neither is part of the production build or the Docker image.

1. Start a throwaway Postgres and migrate it:

   ```sh
   docker run -d --name dm-demo-pg -e POSTGRES_USER=devops \
     -e POSTGRES_PASSWORD=devops -e POSTGRES_DB=devops \
     -p 127.0.0.1:15432:5432 postgres:17
   export DATABASE_URL=postgresql://devops:devops@127.0.0.1:15432/devops
   pnpm db:migrate
   ```

2. Start the local OIDC issuer (the mock issuer of the integration tests). It
   signs every visitor in as `admin@example.com`:

   ```sh
   node scripts/demo/mock-oidc.mjs --port 3998
   ```

3. Start the app against both, with placeholder secrets:

   ```sh
   export BETTER_AUTH_URL=http://localhost:3000 NEXT_PUBLIC_APP_URL=http://localhost:3000
   export BETTER_AUTH_SECRET=demo-secret-demo-secret-demo-secret-0001
   export TOKEN_ENCRYPTION_KEY=$(node -e "console.log(Buffer.alloc(32, 7).toString('base64'))")
   export CRON_SECRET=demo-cron-secret-demo-cron-secret-0001 AUDIT_IP_SALT=demo-audit-salt-demo-audit-salt-01
   export OIDC_ISSUER=http://localhost:3998 OIDC_CLIENT_ID=devops-manager OIDC_CLIENT_SECRET=demo
   export ADMIN_EMAILS=admin@example.com ALLOWED_ACCOUNTS=example-org,example-user
   export GITHUB_APP_ID=1 GITHUB_APP_SLUG=example-devops-manager GITHUB_APP_PRIVATE_KEY=unused
   pnpm dev
   ```

4. Fill the database with synthetic data (example-org, example-user,
   repo-a.., runners, a live queue, billing) and let the app compute the daily
   summaries through its cron endpoint:

   ```sh
   node scripts/demo/seed.mjs --app http://localhost:3000
   ```

Open <http://localhost:3000>, choose "Single sign-on" and you are signed in
as the demo admin. GitHub calls fail with the placeholder App key; pages
fall back to the stored (seeded) data. Remove the container afterwards with
`docker rm -f dm-demo-pg`.

## Pull requests

1. Branch from `main`.
2. Keep each pull request focused on one change.
3. Run the checks locally:

   ```sh
   pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
   pnpm test:integration   # needs TEST_DATABASE_URL pointing at a migrated Postgres
   ```

4. Schema changes come with a migration (`pnpm db:migrate:dev --name <change>`);
   CI fails when `schema.prisma` and the migrations disagree.
5. Use [Conventional Commits](https://www.conventionalcommits.org/) in English,
   for example `feat(webhook): handle repository transfers` or
   `fix(auth): refuse disabled users`.

## Code conventions

- TypeScript strict; no `any` without a reason in a comment.
- Tenant data is read through `src/server/data`, whose functions take a
  `TenantScope`. ESLint blocks Prisma imports elsewhere.
- Every GitHub call goes through the token broker
  (`src/server/github/app.ts`) with the narrowest purpose that works.
- User-facing strings live in `messages/en.json` (source) and
  `messages/de.json`.
- New logic comes with unit tests; security-relevant paths (authz, webhook,
  crypto) also with negative tests.

## Public repository rules

This repository is public. Code, docs, tests, fixtures and commit messages
must not contain personal data, real names, email addresses or references to
private infrastructure. Use `example.com` / `example.org`, accounts such as
`example-org` and `example-user`, and runner labels such as `self-hosted`.
CI runs `scripts/check-personal-data.mjs` on every pull request.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
