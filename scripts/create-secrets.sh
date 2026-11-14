#!/usr/bin/env bash
# Creates the passwords the charts reference. Random, generated once, never stored in Git.
# Safe to re-run: existing Secrets are kept, so passwords never change under a running database.
#
#   middleware/postgres-credentials   postgres superuser + one password per service DB user
#   middleware/rabbitmq-credentials   username / password
#   vijaybank/db-credentials          copy of the service DB passwords (pods can only read
#   vijaybank/rabbitmq-credentials    Secrets in their own namespace)
#   observability/grafana-postgres    read-only Postgres password for Grafana's business dashboards
set -euo pipefail
CTX="${KUBE_CONTEXT:-kind-vijaybank}"
k() { kubectl --context "$CTX" "$@"; }

DB_USERS=(auth customer account ledger transfer payment card grafana-ro)

gen() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24; }   # no early-closing pipe (pipefail)
exists() { k -n "$1" get secret "$2" >/dev/null 2>&1; }
read_key() { k -n "$1" get secret "$2" -o "jsonpath={.data.$3}" | base64 -d; }

for ns in middleware vijaybank observability; do
  k get ns "$ns" >/dev/null 2>&1 || k create ns "$ns"
done

if ! exists middleware postgres-credentials; then
  args=(--from-literal=postgres-password="$(gen)")
  for u in "${DB_USERS[@]}"; do args+=(--from-literal="$u=$(gen)"); done
  k -n middleware create secret generic postgres-credentials "${args[@]}"
fi

if ! exists middleware rabbitmq-credentials; then
  k -n middleware create secret generic rabbitmq-credentials \
    --from-literal=username=vijaybank --from-literal=password="$(gen)"
fi

# Copies for the application namespace, taken from the middleware Secrets.
if ! exists vijaybank db-credentials; then
  args=()
  for u in "${DB_USERS[@]}"; do
    [[ "$u" == grafana-ro ]] && continue
    args+=(--from-literal="$u=$(read_key middleware postgres-credentials "$u")")
  done
  k -n vijaybank create secret generic db-credentials "${args[@]}"
fi

if ! exists vijaybank rabbitmq-credentials; then
  k -n vijaybank create secret generic rabbitmq-credentials \
    --from-literal=username="$(read_key middleware rabbitmq-credentials username)" \
    --from-literal=password="$(read_key middleware rabbitmq-credentials password)"
fi

if ! exists observability grafana-postgres; then
  k -n observability create secret generic grafana-postgres \
    --from-literal=password="$(read_key middleware postgres-credentials grafana-ro)"
fi

k -n middleware get secrets
k -n vijaybank get secrets
k -n observability get secrets
