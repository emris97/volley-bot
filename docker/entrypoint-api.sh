#!/bin/sh
set -eu

case "${1:-serve}" in
  serve)
    exec node apps/api/dist/main.js
    ;;
  migrate)
    exec node dist/scripts/migrate.js
    ;;
  *)
    exec "$@"
    ;;
esac
