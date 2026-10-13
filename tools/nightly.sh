#!/usr/bin/env bash
# One stage of the nightly proof (.github/workflows/nightly.yml) against a mesh
# that is already up, from the repository root:
#
#   tools/nightly.sh <compose|kubernetes> <nats|rabbitmq> <stage>
#
# Stages:
#   status       mesh-admin status says live revocation and minting are on, and
#                the capabilities answer names the broker
#   enroll       mesh-admin makes a tenant and an enrollment key; an agent
#                enrolls with it through the SDK, connects and answers; the
#                operator's view says the tenant holds it
#   conformance  the core conformance profile with --ci
#   revocation   c20 on its own: a revoked credential is cut off live
#   examples     the examples (on Kubernetes, all but 03, which needs Compose)
#
# Nothing secret is printed: the enrollment key goes to a file with mode 600.
set -euo pipefail

where="$1" broker="$2" stage="$3"
root="$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })"
ns="${MESH_KUBE_NAMESPACE:-agent-messaging}"
state="$root/.state/nightly-$where-$broker"
mkdir -p "$state"

# A command in the server's container.
server() {
  if [ "$where" = kubernetes ]; then
    kubectl -n "$ns" exec deploy/server -- "$@"
  else
    docker compose -f "$root/deploy/compose/$broker/compose.yaml" exec -T server "$@"
  fi
}
admin() { server /entrypoint.sh mesh-admin "$@"; }
# The tools read the mesh's files from the pod only when this is set.
if [ "$where" = kubernetes ]; then export MESH_KUBE_NAMESPACE="$ns"; else unset MESH_KUBE_NAMESPACE; fi

case "$stage" in
  status)
    admin status | tee "$state/status.log"
    grep -q "Live revocation: on" "$state/status.log" || { echo "::error::live revocation is not on"; exit 1; }
    grep -q "Credential minting: on" "$state/status.log" || { echo "::error::credential minting is not on"; exit 1; }
    curl -fsS --max-time 10 http://127.0.0.1:3005/v1/capabilities > "$state/capabilities.json"
    grep -q "\"binding\":\"$broker\"" "$state/capabilities.json" || { echo "::error::the capabilities answer does not name $broker"; exit 1; }
    echo "The capabilities answer names $broker."
    ;;
  enroll)
    tenant="nightly-$(date +%s)"
    admin tenants create "$tenant"
    admin tenants key "$tenant" --label "nightly agent" --out /tmp/nightly.key
    server cat /tmp/nightly.key > "$state/enroll.key"
    chmod 600 "$state/enroll.key"
    server rm -f /tmp/nightly.key
    node "$root/tools/enroll-check.mjs" "$state/enroll.key" | tee "$state/enroll.log"
    rm -f "$state/enroll.key"
    agent="$(tail -n 1 "$state/enroll.log")"
    admin agents show "$agent" | tee "$state/agent.log"
    grep -q "$tenant" "$state/agent.log" || { echo "::error::the operator's view of the agent does not name tenant $tenant"; exit 1; }
    echo "The agent is on record under $tenant."
    ;;
  conformance)
    node "$root/tools/conformance.mjs" "$broker" --ci
    ;;
  revocation)
    node "$root/tools/conformance.mjs" "$broker" --ci --only c20 | tee "$state/c20.log"
    grep -Eq "c20.*PASS|PASS.*c20" "$state/c20.log" || { echo "::error::c20 (live revocation) did not pass"; exit 1; }
    ;;
  examples)
    if [ "$where" = kubernetes ]; then
      node "$root/examples/run.mjs" "$broker" 01 02 04 05
    else
      node "$root/examples/run.mjs" "$broker"
    fi
    ;;
  *)
    echo "unknown stage: $stage" >&2
    exit 2
    ;;
esac
