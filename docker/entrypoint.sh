#!/bin/sh
# ROLE=web (default) runs the Next.js server; ROLE=migrate applies pending
# Prisma migrations and exits. <NAME>_FILE variables (Docker secrets) are
# resolved here for the migrate role; the app resolves its own in src/env.ts.
set -eu

load_file_secret() {
  name="$1"
  file_var="${name}_FILE"
  eval "value=\${$name:-}"
  eval "file=\${$file_var:-}"
  if [ -z "$value" ] && [ -n "$file" ]; then
    export "$name=$(cat "$file")"
  fi
}

case "${ROLE:-web}" in
  migrate)
    load_file_secret DATABASE_URL
    load_file_secret DIRECT_URL
    cd /opt/prisma
    exec node node_modules/prisma/build/index.js migrate deploy
    ;;
  web)
    exec node /app/server.js
    ;;
  *)
    echo "Unknown ROLE '${ROLE}', expected web or migrate" >&2
    exit 64
    ;;
esac
