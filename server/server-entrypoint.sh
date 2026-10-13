#!/bin/sh
# The Agent Messaging Server image's entrypoint.
#
#   first-run          set up a new server in $MESH_CONFIG_DIR, once (src/setup/first-run.ts)
#   mesh-admin ARGS    the admin CLI (tools/mesh-admin.mjs), with the token first-run made
#   (anything else)    start the server (src/server-main.ts), passing the arguments on
set -eu

case "${1:-}" in
  first-run)
    shift
    exec ./node_modules/.bin/tsx src/setup/first-run.ts "$@"
    ;;
  mesh-admin)
    shift
    if [ -z "${MESH_ADMIN_TOKEN_FILE:-}" ] && [ -f "${MESH_CONFIG_DIR}/creds/mesh-admin.token" ]; then
      MESH_ADMIN_TOKEN_FILE="${MESH_CONFIG_DIR}/creds/mesh-admin.token"
      export MESH_ADMIN_TOKEN_FILE
    fi
    exec node tools/mesh-admin.mjs "$@"
    ;;
esac

if [ ! -f "${MESH_CONFIG_DIR}/server.env" ]; then
  echo "[server] ${MESH_CONFIG_DIR}/server.env is not there. Run first-run setup once before the first start:" >&2
  echo "[server]   docker run --rm -v <config volume>:${MESH_CONFIG_DIR} <this image> first-run" >&2
  exit 1
fi

exec ./node_modules/.bin/tsx src/server-main.ts "$@"
