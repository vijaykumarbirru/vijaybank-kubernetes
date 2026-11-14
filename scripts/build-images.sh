#!/usr/bin/env bash
# Builds the VijayBank images; with --push also pushes them to the local registry
# that the kind cluster pulls from.
#   scripts/build-images.sh                  build all
#   scripts/build-images.sh --push           build all and push
#   scripts/build-images.sh --push auth-service api-gateway
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-localhost:5001}"
TAG="${TAG:-0.1.0}"

PUSH=false
if [[ "${1:-}" == "--push" ]]; then PUSH=true; shift; fi

if [[ $# -gt 0 ]]; then
  NAMES=("$@")
else
  NAMES=($(ls services) seed)
fi

for name in "${NAMES[@]}"; do
  if [[ "$name" == "seed" ]]; then dir=seed; else dir="services/$name"; fi
  [[ -f "$dir/Dockerfile" ]] || { echo "no Dockerfile in $dir" >&2; exit 1; }
  image="$REGISTRY/vijaybank/$name:$TAG"
  echo "==> $image"
  docker build -q -t "$image" "$dir"
  if $PUSH; then docker push -q "$image"; fi
done

echo "done: ${#NAMES[@]} image(s), tag $TAG"
