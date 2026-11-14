#!/usr/bin/env bash
# Creates the local registry (localhost:5001) and the kind cluster "vijaybank" that pulls from it.
# Follows https://kind.sigs.k8s.io/docs/user/local-registry/
set -euo pipefail
cd "$(dirname "$0")/.."

REG_NAME=vijaybank-registry
REG_PORT=5001

# 1. Registry container (images kept in the vijaybank-registry volume).
if [[ "$(docker inspect -f '{{.State.Running}}' "$REG_NAME" 2>/dev/null || true)" != "true" ]]; then
  docker run -d --restart=always --name "$REG_NAME" \
    -p "127.0.0.1:${REG_PORT}:5000" -v vijaybank-registry:/var/lib/registry registry:2
fi

# 2. Cluster.
if ! kind get clusters | grep -qx vijaybank; then
  kind create cluster --config kind/cluster.yaml
fi

# 3. Tell every node that localhost:5001 means the registry container.
for node in $(kind get nodes --name vijaybank); do
  docker exec "$node" mkdir -p "/etc/containerd/certs.d/localhost:${REG_PORT}"
  printf '[host."http://%s:5000"]\n' "$REG_NAME" |
    docker exec -i "$node" cp /dev/stdin "/etc/containerd/certs.d/localhost:${REG_PORT}/hosts.toml"
done

# 4. Put the registry on the kind network so nodes can reach it by name.
if [[ "$(docker inspect -f '{{json .NetworkSettings.Networks.kind}}' "$REG_NAME")" == "null" ]]; then
  docker network connect kind "$REG_NAME"
fi

# 5. Advertise the registry (KEP-1755) for tools that look for it.
kubectl --context kind-vijaybank apply -f - <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${REG_PORT}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
YAML

kubectl --context kind-vijaybank get nodes
