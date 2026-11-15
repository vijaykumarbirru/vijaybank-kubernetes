# VijayBank on Kubernetes

The VijayBank net-banking microservices (fictional bank, demo data only) running on a local
**kind** cluster, packaged as **Helm** charts and deployed by **Argo CD** (GitOps).

**Full documentation: [docs/GUIDE.md](docs/GUIDE.md)** — architecture, request flow, setup, Helm,
secrets, Argo CD, observability, operations and troubleshooting.

The application code is a copy of the Docker Compose version
([Banking-observability](https://github.com/vijaykumarbirru/Banking-observability)); this repo
adds what is needed to run it on Kubernetes.

```
kind cluster "vijaybank" (1 control-plane + 2 workers)          local registry localhost:5001
├─ traefik      Traefik + Gateway API  → http://bank.localhost, argocd.localhost, rabbitmq.localhost
├─ argocd       Argo CD: syncs everything below from this Git repo
├─ middleware   PostgreSQL, Redis, RabbitMQ, MongoDB (StatefulSets)
├─ vijaybank    13 services + web frontend + seed Job (one Helm chart / Argo app each)
└─ observability OpenTelemetry Collector, Jaeger, Prometheus Operator + Prometheus + Grafana,
                 exporters + health probes, VijayBank dashboards, Request Explorer
                 (+ traces and app metrics to Elastic Cloud as <service>-kubernetes)
```

## Layout

| Path | Contents |
|---|---|
| `services/`, `seed/` | Application code + Dockerfiles (Go, Java, Kotlin, Python, Node.js, .NET, React) |
| `charts/generic-application/` | Shared Helm templates used by every service ([charts/README.md](charts/README.md)) |
| `charts/<service>/` | Thin chart per service: `values.yaml` (wiring) + `values-kind.yaml` (local settings) |
| `charts/middleware/` | Data stores |
| `charts/observability-config/` | ServiceMonitors, health probes, Grafana dashboards + alert, Request Explorer |
| `platform/` | Gateway API CRDs, Traefik and Argo CD values (official charts, pinned versions) |
| `argocd/` | Root "app of apps" + one Application per component, ApplicationSet for the services |
| `kind/`, `scripts/` | Cluster definition and helper scripts (`build-dashboards.py` regenerates the dashboards) |

## Quick start

Needs Docker Desktop (~8 GB memory for the cluster), `kind`, `kubectl`, `helm`.

```bash
# 1. Registry + cluster
./scripts/create-cluster.sh

# 2. Build the images and push them to the local registry
./scripts/build-images.sh --push

# 3. Passwords (random, created once, never stored in Git). For the Elastic Cloud export,
#    first copy .env.example to .env (git-ignored) and fill in your endpoint and API key.
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

Check it with `python3 scripts/smoke-test.py` (19 end-to-end checks through Traefik).

Argo CD then creates the data stores, the 14 service apps and the seed Job, and keeps them
in sync with `main`. Without Argo CD, `./scripts/helm-install-all.sh` installs the same charts
with plain Helm.

| URL | What |
|---|---|
| http://bank.localhost | Net banking. Log in as `VB100001` … `VB100020` (demo password printed by the seed Job); OTPs are in the dev inbox |
| http://argocd.localhost | Argo CD. User `admin`, password: `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' \| base64 -d` |
| http://grafana.localhost | Grafana (no login): Prometheus, Jaeger and read-only Postgres data sources |
| http://prometheus.localhost | Prometheus |
| http://explorer.localhost | Request Explorer: replays a real request hop by hop (Traefik → pods → data stores), with pod, node, Service IP and network layers |
| http://jaeger.localhost | Jaeger: every request as a trace (Traefik → nginx → gateway → services → data stores) |
| http://rabbitmq.localhost | RabbitMQ UI. User `vijaybank`, password: `kubectl -n middleware get secret rabbitmq-credentials -o jsonpath='{.data.password}' \| base64 -d` |

`*.localhost` resolves to 127.0.0.1 in browsers and curl.

## Day to day

```bash
# Change a service: edit charts/<service>/values*.yaml, commit, push -> Argo CD rolls it out.
# New code: rebuild + push the image with a new tag, then bump image.tag in values-kind.yaml.
TAG=0.1.1 ./scripts/build-images.sh --push auth-service
```

## Stop and start

### Option 1: pause and resume (keeps all data)

Databases, traces, metrics, Argo CD state and images all survive.

**Stop**

```bash
# 1. Stop the 3 cluster nodes (all pods stop with them)
docker stop vijaybank-control-plane vijaybank-worker vijaybank-worker2

# 2. (optional) stop the local image registry too
docker stop vijaybank-registry
```

This frees about 8 GB of Docker Desktop memory; you can then quit Docker Desktop.

**Start**

```bash
# 1. Start Docker Desktop first (if it was quit), then the registry before the nodes
docker start vijaybank-registry
docker start vijaybank-control-plane vijaybank-worker vijaybank-worker2

# 2. Wait for the nodes, then for the app pods (the Java services take ~2 minutes)
kubectl --context kind-vijaybank wait --for=condition=Ready nodes --all --timeout=180s
kubectl --context kind-vijaybank wait --for=condition=Ready pods --all -n vijaybank --timeout=600s \
  --field-selector=status.phase!=Succeeded

# 3. Check
kubectl --context kind-vijaybank -n argocd get applications      # all Synced / Healthy
python3 scripts/smoke-test.py                                      # 19 passed, 0 failed
```

- The kind node containers **don't start by themselves** after Docker Desktop restarts: always run the `docker start` lines.
- The seed Job doesn't run again: customers, balances and history are kept.
- Graphs show a gap for the time the cluster was stopped.
- A few pods may restart once while PostgreSQL and RabbitMQ come up; they settle on their own.

### Option 2: delete and rebuild (clean start)

**Stop (delete)**

```bash
kind delete cluster --name vijaybank       # cluster, all data and volumes are removed
docker rm -f vijaybank-registry            # (optional) the registry and its stored images
```

The code and this Git repo are not affected.

**Start (rebuild)**

Run the [Quick start](#quick-start) again (about 10 minutes). You get new random passwords,
fresh demo customers and empty traces and metrics.

Use option 1 day to day; option 2 to free disk space or start clean.
