# VijayBank on Kubernetes

The VijayBank net-banking microservices (fictional bank, demo data only) running on a local
**kind** cluster, packaged as **Helm** charts and deployed by **Argo CD** (GitOps).

The application code is a copy of the Docker Compose version
([Banking-observability](https://github.com/vijaykumarbirru/Banking-observability)); this repo
adds what is needed to run it on Kubernetes.

```
kind cluster "vijaybank" (1 control-plane + 2 workers)          local registry localhost:5001
├─ traefik      Traefik + Gateway API  → http://bank.localhost, argocd.localhost, rabbitmq.localhost
├─ argocd       Argo CD: syncs everything below from this Git repo
├─ middleware   PostgreSQL, Redis, RabbitMQ, MongoDB (StatefulSets)
└─ vijaybank    13 services + web frontend + seed Job (one Helm chart / Argo app each)
```

## Layout

| Path | Contents |
|---|---|
| `services/`, `seed/` | Application code + Dockerfiles (Go, Java, Kotlin, Python, Node.js, .NET, React) |
| `charts/generic-application/` | Shared Helm templates used by every service ([charts/README.md](charts/README.md)) |
| `charts/<service>/` | Thin chart per service: `values.yaml` (wiring) + `values-kind.yaml` (local settings) |
| `charts/middleware/` | Data stores |
| `platform/` | Gateway API CRDs, Traefik and Argo CD values (official charts, pinned versions) |
| `argocd/` | Root "app of apps" + one Application per component, ApplicationSet for the services |
| `kind/`, `scripts/` | Cluster definition and helper scripts |

## Quick start

Needs Docker Desktop (~8 GB memory for the cluster), `kind`, `kubectl`, `helm`.

```bash
# 1. Registry + cluster
./scripts/create-cluster.sh

# 2. Build the images and push them to the local registry
./scripts/build-images.sh --push

# 3. Passwords (random, created once, never stored in Git)
./scripts/create-secrets.sh

# 4. Gateway API + Traefik + Argo CD
kubectl apply --server-side -f platform/gateway-api/gateway-api-v1.6.1-standard.yaml
helm repo add traefik https://traefik.github.io/charts
helm repo add argo https://argoproj.github.io/argo-helm
helm upgrade --install traefik traefik/traefik --version 41.6.0 -n traefik --create-namespace -f platform/traefik/values.yaml
helm upgrade --install argocd argo/argo-cd --version 10.17.2 -n argocd --create-namespace -f platform/argocd/values.yaml

# 5. Hand everything else to Argo CD
kubectl apply -f argocd/root-app.yaml
```

Argo CD then creates the data stores, the 14 service apps and the seed Job, and keeps them
in sync with `main`. Without Argo CD, `./scripts/helm-install-all.sh` installs the same charts
with plain Helm.

| URL | What |
|---|---|
| http://bank.localhost | Net banking. Log in as `VB100001` … `VB100020` (demo password printed by the seed Job); OTPs are in the dev inbox |
| http://argocd.localhost | Argo CD. User `admin`, password: `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' \| base64 -d` |
| http://rabbitmq.localhost | RabbitMQ UI. User `vijaybank`, password: `kubectl -n middleware get secret rabbitmq-credentials -o jsonpath='{.data.password}' \| base64 -d` |

`*.localhost` resolves to 127.0.0.1 in browsers and curl.

## Day to day

```bash
# Change a service: edit charts/<service>/values*.yaml, commit, push -> Argo CD rolls it out.
# New code: rebuild + push the image with a new tag, then bump image.tag in values-kind.yaml.
TAG=0.1.1 ./scripts/build-images.sh --push auth-service

# Stop / start the cluster (keeps all data)
docker stop vijaybank-control-plane vijaybank-worker vijaybank-worker2
docker start vijaybank-control-plane vijaybank-worker vijaybank-worker2

# Delete it (registry and images stay)
kind delete cluster --name vijaybank
```
