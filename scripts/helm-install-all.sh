#!/usr/bin/env bash
# Installs / upgrades every VijayBank chart with plain Helm (before Argo CD takes over).
#   scripts/helm-install-all.sh            middleware + services + seed
#   scripts/helm-install-all.sh services   services + seed only
set -euo pipefail
cd "$(dirname "$0")/.."
CTX="${KUBE_CONTEXT:-kind-vijaybank}"
h() { helm --kube-context "$CTX" "$@"; }

if [[ "${1:-all}" == all ]]; then
  h upgrade --install middleware charts/middleware -n middleware --create-namespace --wait --timeout 6m
fi

SERVICES=$(ls charts | grep -vE '^(generic-application|middleware|seed|README.md)$')
for svc in $SERVICES; do
  h dependency build "charts/$svc" >/dev/null
  h upgrade --install "$svc" "charts/$svc" -n vijaybank -f "charts/$svc/values-kind.yaml"
done

echo "waiting for the services to become ready..."
kubectl --context "$CTX" -n vijaybank wait --for=condition=Available deployment --all --timeout=10m

# The seed Job only runs once; it is skipped when it already exists.
h dependency build charts/seed >/dev/null
if ! kubectl --context "$CTX" -n vijaybank get job seed >/dev/null 2>&1; then
  h upgrade --install seed charts/seed -n vijaybank -f charts/seed/values-kind.yaml
fi
kubectl --context "$CTX" -n vijaybank wait --for=condition=Complete job/seed --timeout=10m
kubectl --context "$CTX" -n vijaybank get pods -o wide
