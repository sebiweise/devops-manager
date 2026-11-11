# Contributing

Thanks for helping. Bug reports, ideas and pull requests are welcome.

## Before you start

- For larger changes, open an issue first so the approach can be agreed on.
- Security issues: do **not** open a public issue, see [SECURITY.md](SECURITY.md).

## Development setup

See [README.md#development](README.md#development). In short: Node 22+, pnpm,
a local Postgres, `pnpm install`, `pnpm db:migrate:dev`, `pnpm dev`.

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
