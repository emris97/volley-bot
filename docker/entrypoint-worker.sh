#!/bin/sh
set -eu

case "${1:-serve}" in
  serve)
    exec node apps/worker/dist/main.js
    ;;
  *)
    exec "$@"
    ;;
esac
