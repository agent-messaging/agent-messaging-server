#!/usr/bin/env bash
# Two Agent Messaging meshes on this machine, for t15 (a visit, SPEC §21.14 to
# §21.20). Built from this checkout (deploy/compose/nats with compose.build.yaml).
#
#   rig/visit-meshes.sh up     start both, and print the settings t15 reads
#   rig/visit-meshes.sh down   stop both and delete their volumes, the network
#                              and the image
#
# Mesh A (project visit-a) is the visitor's home: its server answers on this
# machine at localhost:3015 and, to mesh B, at http://mesh-a:3005 on the shared
# network, which is the home mesh its agents' cards name. Mesh B (visit-b)
# takes visitors: localhost:3025, which is also its own public address, and it
# trusts the naming service t15 starts on this machine at port 3099
# (host.docker.internal from inside B).
set -euo pipefail
# `pwd -W` on Git Bash for Windows, so docker is handed D:/... rather than /d/...
here() { pwd -W 2>/dev/null || pwd; }
HERE="$(cd "$(dirname "$0")" && here)"
ROOT="$(cd "$HERE/../../.." && here)"
C="$ROOT/deploy/compose/nats"
STATE="$ROOT/.state/visit-rig"
export MSYS_NO_PATHCONV=1

compose() { # project, then compose arguments
  local p="$1"; shift
  docker compose -p "$p" -f "$C/compose.yaml" -f "$C/compose.build.yaml" -f "$HERE/visit.compose.yaml" "$@"
}

mesh() { # project nats ws server gateway public-url alias visits registrars
  MESH_NAME="$1" NATS_PORT="$2" NATS_WS_PORT="$3" SERVER_PORT="$4" GATEWAY_PORT="$5" \
  MESH_NATS_ENDPOINTS="nats://localhost:$2,ws://localhost:$3" MESH_PUBLIC_URL="$6" \
  MESH_ALIAS="$7" MESH_VISITS="$8" MESH_VISIT_REGISTRARS="$9" \
    compose "$1" up -d --wait server >/dev/null
  compose "$1" cp server:/config/creds/mesh-admin.token "$STATE/$1.token" >/dev/null
}

case "${1:-}" in
  up)
    mkdir -p "$STATE"
    docker network create visit-net >/dev/null 2>&1 || true
    mesh visit-a 4232 4453 3015 8091 http://mesh-a:3005 mesh-a off ""
    mesh visit-b 4242 4463 3025 8092 http://localhost:3025 mesh-b on http://host.docker.internal:3099
    cat <<EOF
export PEER_VISIT_A_API=http://localhost:3015
export PEER_VISIT_A_HOME=http://mesh-a:3005
export PEER_VISIT_A_TOKEN_FILE=$STATE/visit-a.token
export PEER_VISIT_B_API=http://localhost:3025
export PEER_VISIT_B_TOKEN_FILE=$STATE/visit-b.token
export PEER_VISIT_NAMING_PORT=3099
export PEER_VISIT_NAMING_URL=http://host.docker.internal:3099
EOF
    ;;
  down)
    compose visit-a down -v >/dev/null 2>&1 || true
    compose visit-b down -v >/dev/null 2>&1 || true
    docker network rm visit-net >/dev/null 2>&1 || true
    docker image rm agent-messaging-server:local >/dev/null 2>&1 || true
    rm -rf "$STATE"
    ;;
  *)
    echo "usage: rig/visit-meshes.sh up|down" >&2
    exit 2
    ;;
esac
